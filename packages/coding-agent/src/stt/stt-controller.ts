import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { type SttStreamHandle, sttClient } from "./asr-client";
import { type CloudSttContext, type CloudSttProvider, parseCloudSttProvider, startCloudSttStream } from "./cloud";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec } from "./models";
import { evaluateSubmitTrigger } from "./submit-trigger";

export type SttState = "idle" | "recording" | "transcribing";

/**
 * What asked for the current state change. `"hold"` is push-to-talk (the space
 * bar / any hold gesture): a release stops recordings it started, and it never
 * touches a latched session. `"handsFree"` is the latched toggle (a key like
 * Ctrl+Space or the triple-tap burst): it starts a session that survives key
 * release and stops it on the next trigger. Push-to-talk never stops a latched
 * recording — the user may be mid-thought with the terminal unfocused — and the
 * latch never hijacks an active hold recording.
 */
export type SttTrigger = "hold" | "handsFree";

interface ToggleOptions {
	trigger?: SttTrigger;
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
	/** Force a redraw after async edits to the composer (live segment/preview inserts). */
	requestRender?(): void;
}

/** The slice of the composer editor the controller drives. */
interface Editor {
	insertText(text: string): void;
	setVolatileText(text: string): void;
	clearVolatileText(): void;
	commitVolatileText(text: string): void;
	submit(): void;
	deleteBeforeCursor(count: number): void;
}

interface CaptureHandle {
	stop(): void;
}

type CaptureFactory = (
	sampleRate: number,
	onAudio: (error: Error | null, samples: Float32Array) => void,
) => CaptureHandle;

export interface STTControllerOptions {
	/**
	 * Resolve the cloud auth context for the current session. Called once per
	 * recording so focus/session switches never stick to a stale session id.
	 * Absent in local-only SDK/test use: selecting a cloud provider without a
	 * resolver is an explicit error, never a silent local fallback.
	 */
	cloud?: () => CloudSttContext;
	createCapture?: CaptureFactory;
}

const LOCAL_SAMPLE_RATE = 16_000;
const XAI_SAMPLE_RATE = 16_000;
const CODEX_SAMPLE_RATE = 24_000;
const WARNING_BODY_LIMIT = 2_048;

function cleanCloudText(text: string): string {
	return sanitizeText(text.replaceAll("\t", " ")).replace(/\s+/g, " ").trim();
}

function cleanWarning(message: string): string {
	const cleaned = sanitizeText(message.replaceAll("\t", " ")).trim();
	return cleaned.length > WARNING_BODY_LIMIT ? `${cleaned.slice(0, WARNING_BODY_LIMIT)}…` : cleaned;
}

/** Coordinates microphone capture with local or provider transcription. */
export class STTController {
	#state: SttState = "idle";
	#resolvedModelKey: string | null = null;
	#toggling = false;
	/** Trigger whose stop request arrived while the start was still in flight; applied once the
	 *  start finishes so a hold release can never cancel a latched start (and vice versa). */
	#stopAfterStart: SttTrigger | null = null;
	/** Which trigger owns the session currently recording (or being started). Set on
	 *  start, cleared on cleanup; a release only stops a session its own trigger started. */
	#trigger: SttTrigger | null = null;
	#disposed = false;
	readonly #createCapture: CaptureFactory;
	readonly #resolveCloud: (() => CloudSttContext) | undefined;

	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: CaptureHandle | null = null;
	#streamEditor: Editor | null = null;
	#streamCommitted = false;
	#streamAbort: AbortController | null = null;
	#streamUtterance = "";
	#streamCloud = false;
	#cloudPreview = "";
	#cloudProvider: CloudSttProvider | null = null;
	#generation = 0;

	/** Creates a controller; tests may replace the hardware capture boundary. */
	constructor(options: STTControllerOptions = {}) {
		this.#resolveCloud = options.cloud;
		this.#createCapture = options.createCapture ?? ((sampleRate, onAudio) => new AudioCapture(sampleRate, onAudio));
	}

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: ToggleOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(editor: Editor, options: ToggleOptions): Promise<void> {
		const trigger = options.trigger ?? "hold";
		if (this.#toggling) {
			// A stop that arrives while the start is still awaiting its preflight: remember which
			// trigger asked, so a hold release can never cancel a latched start (and vice versa).
			// Only the trigger that owns the in-flight session may arm it — a press from the other
			// trigger is ignored here exactly as the ownership gate below ignores it for a live
			// session, and it must never overwrite a stop the owner already asked for.
			if (
				(this.#state === "idle" || this.#state === "recording") &&
				(this.#trigger === null || this.#trigger === trigger)
			) {
				this.#stopAfterStart = trigger;
			}
			return;
		}
		// While one trigger owns the session, only that trigger may end it. A
		// push-to-talk release must not cut off a hands-free dictation the user is
		// still speaking into (they may have alt-tabbed away), and a stray hold must
		// not stop a latched recording either.
		if (this.#trigger !== null && this.#trigger !== trigger) return;
		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle": {
					this.#trigger = trigger;
					await this.#start(editor, options);
					// Every successful start ends in `recording`; a preflight or microphone
					// failure leaves the state idle with the mic unclaimed, so drop ownership
					// instead of locking out the other trigger for the rest of the session.
					const settled = this.state;
					if (settled !== "recording") this.#trigger = null;
					break;
				}
				case "recording":
					await this.#stop(options);
					break;
				case "transcribing":
					options.showStatus("Transcription in progress...");
					break;
			}
			if (this.#stopAfterStart === trigger && this.#state === "recording") {
				await this.#stop(options);
			}
			// Whether or not it applied, the slot is spent: a stop tagged for the other trigger can
			// never end this session, and leaving it set would arm the *next* toggle of that trigger
			// to stop itself the moment it starts.
			this.#stopAfterStart = null;
		} finally {
			this.#toggling = false;
		}
	}

	/** True while a latched (hands-free) session owns the microphone. */
	get handsFreeActive(): boolean {
		return this.#trigger === "handsFree";
	}

	async #ensureDeps(options: ToggleOptions): Promise<boolean> {
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		// Keyed on the model rather than a one-shot flag: switching stt.modelName
		// mid-session must re-run preflight so an uncached new tier downloads here
		// (with progress) instead of blocking silently at stop.
		if (this.#resolvedModelKey === modelKey) return true;
		try {
			// Only clear the status line when preflight emitted progress; the
			// cached-model fast path emits nothing.
			let wroteStatus = false;
			const status = (msg: string): void => {
				wroteStatus = true;
				options.showStatus(msg);
			};
			// Loading the multi-hundred-MB speech model into the worker is what made
			// the old "Checking STT dependencies…" step slow. Don't pay it before
			// recording: when the weights are already cached, start now and warm the
			// model in the background — the stream/transcribe paths load it on demand
			// (memoized in the worker) and it is hot by the time recording stops.
			// Only a genuine first-use download blocks, with explicit progress, so we
			// never record silently against missing weights.
			if (await isSttModelCached(modelKey)) {
				this.#warmModel(modelKey);
			} else {
				await downloadSttModel(modelKey, p => status(`Downloading speech model ${p.label} (${p.percent}%)`));
			}
			if (wroteStatus) options.showStatus("");
			this.#resolvedModelKey = modelKey;
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return false;
		}
	}

	/** Warm the speech model in the worker without blocking recording. The worker
	 *  memoizes the load, so the stream/transcribe path reuses it and the model is
	 *  hot by the time recording stops. Only called when the weights are already
	 *  cached, so no network fetch happens. On load failure (corrupt cache, OOM,
	 *  runtime install) invalidate the resolved key so the next toggle re-runs
	 *  preflight and retries instead of skipping it forever. */
	#warmModel(modelKey: string): void {
		void downloadSttModel(modelKey).catch(err => {
			// Guard against a concurrent model switch clobbering a newer resolution.
			if (!this.#disposed && this.#resolvedModelKey === modelKey) this.#resolvedModelKey = null;
			logger.debug("stt: background model warmup failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	#readProvider(): string {
		try {
			const value = settings.get("stt.provider");
			return typeof value === "string" ? value : "local";
		} catch {
			return "local";
		}
	}

	async #start(editor: Editor, options: ToggleOptions): Promise<void> {
		const providerValue = this.#readProvider();
		if (providerValue === "local") {
			if (!(await this.#ensureDeps(options))) return;
			await this.#startStreaming(editor, options);
			return;
		}
		const provider = parseCloudSttProvider(providerValue);
		if (!provider) {
			options.showWarning(`Unknown speech provider: ${providerValue}`);
			return;
		}
		await this.#startCloud(editor, provider, options);
	}

	async #stop(options: ToggleOptions): Promise<void> {
		await this.#stopStreaming(options);
	}

	// ── Live streaming ──────────────────────────────────────────────

	/** Segment text gets a leading space once a prior segment is committed, so
	 *  phrases join naturally; the first phrase is inserted at the cursor as-is. */
	#prefixed(text: string): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	async #startStreaming(editor: Editor, options: ToggleOptions): Promise<void> {
		// `dispose()` can land while the preflight above was awaiting (a first-run model download);
		// bail before opening a stream and the microphone that nothing would then stop, so the state
		// stays idle and the caller drops ownership.
		if (this.#disposed) return;
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		const language = settings.get("stt.language") as string | undefined;
		this.#streamEditor = editor;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamCloud = false;
		this.#cloudProvider = null;
		this.#streamAbort = new AbortController();
		const generation = ++this.#generation;
		const stream = sttClient.startStream(modelKey, {
			language: language || undefined,
			signal: this.#streamAbort.signal,
			onPartial: text => {
				if (this.#disposed || this.#stream !== stream || this.#state !== "recording") return;
				this.#streamEditor?.setVolatileText(this.#prefixed(text));
				options.requestRender?.();
			},
			onSegment: text => {
				if (this.#disposed || this.#generation !== generation) return;
				const prefixed = this.#prefixed(text);
				if (prefixed) {
					this.#streamEditor?.commitVolatileText(prefixed);
					this.#streamCommitted = true;
					this.#streamUtterance += prefixed;
				} else {
					this.#streamEditor?.clearVolatileText();
				}
				options.requestRender?.();
			},
		});
		this.#stream = stream;
		let recorder: CaptureHandle;
		try {
			recorder = this.#createCapture(LOCAL_SAMPLE_RATE, (error, samples) =>
				this.#handleCaptureAudio(generation, stream, options, error, samples),
			);
		} catch (err) {
			stream.cancel();
			this.#cleanupStream();
			const msg = err instanceof Error ? err.message : "Failed to start microphone capture";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return;
		}
		this.#streamRecorder = recorder;
		this.#setState("recording", options);
		logger.debug("STT live recording started", { modelKey });
	}

	async #startCloud(editor: Editor, provider: CloudSttProvider, options: ToggleOptions): Promise<void> {
		if (!this.#resolveCloud) {
			options.showWarning("Cloud speech-to-text needs a session context and is unavailable here.");
			return;
		}
		let context: CloudSttContext;
		try {
			context = this.#resolveCloud();
		} catch (err) {
			options.showWarning(cleanWarning(err instanceof Error ? err.message : "Failed to resolve speech context"));
			return;
		}
		const language = settings.get("stt.language") as string | undefined;
		const abort = new AbortController();
		this.#streamAbort = abort;
		const generation = ++this.#generation;
		let stream: SttStreamHandle;
		try {
			stream = await startCloudSttStream(context, provider, {
				language: language || undefined,
				signal: abort.signal,
				onPartial: text => {
					if (this.#disposed || this.#generation !== generation || this.#stream !== stream) return;
					// Cloud previews are whole-dictation replacements valid while the
					// final flush is still pending; local segment commits never run here.
					if (this.#state !== "recording" && this.#state !== "transcribing") return;
					this.#cloudPreview = cleanCloudText(text);
					this.#streamEditor?.setVolatileText(this.#cloudPreview);
					options.requestRender?.();
				},
				onError: () => {
					if (this.#disposed || this.#generation !== generation || this.#stream !== stream) return;
					// Recorded only: the stop path surfaces the failure once via the
					// stream rejection, keeping a single warning for the recording.
					logger.debug("stt: cloud stream error", { provider });
				},
				onStatus: message => {
					if (this.#disposed || this.#generation !== generation || this.#stream !== stream) return;
					options.showStatus(message);
				},
			});
		} catch (err) {
			this.#streamAbort = null;
			if (abort.signal.aborted || this.#disposed) return;
			const msg = cleanWarning(err instanceof Error ? err.message : "Failed to start cloud speech-to-text");
			options.showWarning(msg);
			logger.error("STT cloud preflight failed", { provider });
			return;
		}
		if (
			this.#disposed ||
			this.#generation !== generation ||
			abort.signal.aborted ||
			// Only a stop from the trigger that owns this start cancels it: a hold release (or a latch
			// press) arriving while the other trigger's start is in flight must not kill the session.
			this.#stopAfterStart === this.#trigger
		) {
			abort.abort();
			stream.cancel();
			this.#streamAbort = null;
			return;
		}
		this.#stream = stream;
		this.#streamEditor = editor;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamCloud = true;
		this.#cloudProvider = provider;
		this.#cloudPreview = "";
		const sampleRate = provider === "openai-codex" ? CODEX_SAMPLE_RATE : XAI_SAMPLE_RATE;
		let recorder: CaptureHandle;
		try {
			recorder = this.#createCapture(sampleRate, (error, samples) =>
				this.#handleCaptureAudio(generation, stream, options, error, samples),
			);
		} catch (err) {
			stream.cancel();
			this.#cleanupStream();
			const msg = err instanceof Error ? err.message : "Failed to start microphone capture";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return;
		}
		this.#streamRecorder = recorder;
		this.#setState("recording", options);
		logger.debug("STT cloud recording started", { provider });
	}

	#handleCaptureAudio(
		generation: number,
		stream: SttStreamHandle,
		options: ToggleOptions,
		error: Error | null,
		samples: Float32Array,
	): void {
		if (this.#disposed || this.#generation !== generation || this.#stream !== stream) return;
		if (this.#state !== "recording") return;
		if (error) {
			logger.error("Native microphone capture failed", { error: error.message });
			const activeRecorder = this.#streamRecorder;
			this.#streamRecorder = null;
			try {
				activeRecorder?.stop();
			} catch (cause) {
				logger.debug("stt: microphone cleanup failed", {
					error: cause instanceof Error ? cause.message : String(cause),
				});
			}
			this.#streamAbort?.abort(error);
			stream.cancel();
			this.#streamEditor?.clearVolatileText();
			options.requestRender?.();
			this.#cleanupStream();
			this.#setState("idle", options);
			options.showWarning(error.message);
			return;
		}
		try {
			stream.pushAudio(samples);
		} catch (err) {
			logger.debug("stt: audio push failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async #stopStreaming(options: ToggleOptions): Promise<void> {
		const stream = this.#stream;
		const recorder = this.#streamRecorder;
		if (!stream) {
			this.#setState("idle", options);
			return;
		}
		const cloud = this.#streamCloud;
		this.#setState("transcribing", options);
		// Stop the mic first so no further audio is fed, then flush the worker.
		try {
			recorder?.stop();
		} catch (err) {
			logger.debug("stt: streaming recorder stop failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		try {
			finalText = (await stream.stop()).trim();
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = cleanWarning(err instanceof Error ? err.message : "Transcription failed");
				options.showWarning(msg);
				logger.error("STT live transcription failed", {
					provider: this.#cloudProvider ?? "local",
				});
			}
		}
		if (this.#disposed) {
			this.#cleanupStream();
			return;
		}
		if (failed) {
			// Keep the last cloud preview as an editable draft; local failures
			// leave whatever the worker committed. Never auto-submit an error.
			if (cloud && this.#cloudPreview) {
				this.#streamEditor?.commitVolatileText(this.#cloudPreview);
			} else {
				this.#streamEditor?.clearVolatileText();
			}
			options.requestRender?.();
			this.#cleanupStream();
			this.#setState("idle", options);
			return;
		}
		if (!this.#streamCommitted && finalText) {
			const prefixed = cloud ? cleanCloudText(finalText) : this.#prefixed(finalText);
			this.#streamEditor?.commitVolatileText(prefixed);
			this.#streamCommitted = true;
			this.#streamUtterance = prefixed;
		} else {
			this.#streamEditor?.clearVolatileText();
		}
		options.requestRender?.();
		if (!failed) options.showStatus(this.#streamCommitted ? "" : "No speech detected.");

		if (this.#streamCommitted && !failed && this.#streamEditor) {
			const trigger = settings.get("stt.submitTrigger");
			const { submit, trimTrailing } = evaluateSubmitTrigger(this.#streamUtterance, trigger);
			if (trimTrailing > 0) {
				this.#streamEditor.deleteBeforeCursor(trimTrailing);
			}
			if (submit) {
				this.#streamEditor.submit();
			}
		}

		this.#cleanupStream();
		this.#setState("idle", options);
	}

	#cleanupStream(): void {
		this.#stream = null;
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
		this.#streamCloud = false;
		this.#cloudProvider = null;
		this.#cloudPreview = "";
		// The session is over: whoever started it no longer owns the microphone.
		this.#trigger = null;
	}

	dispose(): void {
		this.#disposed = true;
		this.#generation += 1;
		if (this.#streamAbort) {
			this.#streamAbort.abort();
			this.#streamAbort = null;
		}
		this.#stream?.cancel();
		try {
			this.#streamRecorder?.stop();
		} catch {
			// best effort cleanup
		}
		this.#cleanupStream();
		this.#state = "idle";
		this.#resolvedModelKey = null;
	}
}
