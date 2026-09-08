import { type ApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import { logger } from "@oh-my-pi/pi-utils";
import type { XAIHttpProvider } from "../lib/xai-http";
import { encodePcm16 } from "../tts/wav";
import type { SttStreamHandle } from "./asr-client";
import type { CloudSttOptions } from "./cloud";

export interface XaiSttOptions extends CloudSttOptions {
	provider: XAIHttpProvider;
	apiKey: ApiKey;
	baseURL: string;
	headers?: Record<string, string>;
}

const XAI_CONNECT_TIMEOUT_MS = 15_000;
const XAI_CREATED_TIMEOUT_MS = 10_000;
const XAI_FINISH_TIMEOUT_MS = 10_000;
const XAI_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

class XaiSttConnectError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "XaiSttConnectError";
		this.status = status;
	}
}

function buildXaiSttUrl(baseURL: string, language: string | undefined): URL {
	const normalized = baseURL.replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(`${normalized}/stt`);
	} catch {
		throw new Error(`Invalid xAI STT base URL: ${normalized}`);
	}
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	else throw new Error(`Unsupported xAI STT URL scheme: ${url.protocol}`);
	url.searchParams.set("sample_rate", "16000");
	url.searchParams.set("encoding", "pcm");
	url.searchParams.set("interim_results", "true");
	url.searchParams.set("endpointing", "400");
	if (language && language !== "auto") url.searchParams.set("language", language);
	return url;
}

function parseCloseAuthStatus(code: number): number | undefined {
	if (code === 4401) return 401;
	if (code === 4403) return 403;
	return undefined;
}

interface XaiPartialEvent {
	text: string;
	isFinal: boolean;
	speechFinal: boolean;
}

type XaiParsedEvent =
	| { kind: "created" }
	| { kind: "partial"; event: XaiPartialEvent }
	| { kind: "done"; text: string }
	| { kind: "error"; message: string }
	| { kind: "unknown" }
	| { kind: "malformed"; message: string };

function parseXaiEvent(raw: string): XaiParsedEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			kind: "malformed",
			message: `xAI STT returned an invalid event payload: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "malformed", message: "xAI STT returned an invalid event payload." };
	}
	const type = "type" in parsed && typeof parsed.type === "string" ? parsed.type : undefined;
	switch (type) {
		case "transcript.created":
			return { kind: "created" };
		case "transcript.partial": {
			const text = "text" in parsed ? parsed.text : undefined;
			const isFinal = "is_final" in parsed ? parsed.is_final : undefined;
			const speechFinal = "speech_final" in parsed ? parsed.speech_final : undefined;
			if (
				(text !== undefined && typeof text !== "string") ||
				(isFinal !== undefined && typeof isFinal !== "boolean") ||
				(speechFinal !== undefined && typeof speechFinal !== "boolean")
			) {
				return { kind: "malformed", message: "xAI STT returned a malformed partial event." };
			}
			return {
				kind: "partial",
				event: {
					text: typeof text === "string" ? text : "",
					isFinal: typeof isFinal === "boolean" ? isFinal : false,
					speechFinal: typeof speechFinal === "boolean" ? speechFinal : false,
				},
			};
		}
		case "transcript.done": {
			const text = "text" in parsed ? parsed.text : undefined;
			if (text !== undefined && typeof text !== "string") {
				return { kind: "malformed", message: "xAI STT returned a malformed done event." };
			}
			return { kind: "done", text: typeof text === "string" ? text : "" };
		}
		case "error": {
			const message = "message" in parsed ? parsed.message : undefined;
			return {
				kind: "error",
				message: typeof message === "string" && message ? message : "unknown error",
			};
		}
		default:
			return { kind: "unknown" };
	}
}

/**
 * Streaming dictation over `wss://<base>/stt` with binary PCM16 LE mono frames
 * at 16 kHz. Mirrors the official Grok CLI session: wait for
 * `transcript.created`, send binary audio, finish with exactly one
 * `{"type":"audio.done"}`.
 */
export function createXaiSttStream(options: XaiSttOptions): SttStreamHandle {
	const factory =
		options.webSocketFactory ??
		((url: string, wsOptions: Bun.WebSocketOptions) =>
			Reflect.construct(WebSocket, [url, wsOptions]) as Bun.WebSocket);
	const signal = options.signal;
	signal?.throwIfAborted();

	const queue: Uint8Array[] = [];
	let queuedBytes = 0;
	const completed: string[] = [];
	let lockedPrefix = "";
	let interim = "";
	let lastEmitted = "";

	let socket: Bun.WebSocket | null = null;
	let ready = false;
	let stopping = false;
	let settled = false;
	let doneSent = false;
	let errorNotified = false;

	const stopDeferred = Promise.withResolvers<string>();
	// A terminal failure can land before the caller awaits stop(); never surface
	// it as an unhandled rejection — stop() still observes it.
	void stopDeferred.promise.catch(() => {});
	const readyDeferred = Promise.withResolvers<void>();
	void readyDeferred.promise.catch(() => {});
	const doneDeferred = Promise.withResolvers<void>();
	void doneDeferred.promise.catch(() => {});

	function preview(): string {
		const parts: string[] = [...completed];
		if (lockedPrefix) parts.push(lockedPrefix);
		if (interim) parts.push(interim);
		return parts.join(" ");
	}

	function emitPartial(): void {
		const text = preview();
		if (text === lastEmitted) return;
		lastEmitted = text;
		try {
			options.onPartial?.(text);
		} catch {
			// Preview observers must never break the stream.
		}
	}

	function cleanupSocket(): void {
		const active = socket;
		socket = null;
		if (!active) return;
		try {
			active.onopen = null;
			active.onmessage = null;
			active.onerror = null;
			active.onclose = null;
		} catch {
			// Best effort.
		}
		try {
			active.close(1000, "done");
		} catch {
			// Already gone.
		}
	}

	function fail(error: Error): void {
		if (settled) return;
		settled = true;
		cleanupSocket();
		queue.length = 0;
		queuedBytes = 0;
		logger.debug("stt: xAI stream failed", { provider: options.provider });
		readyDeferred.reject(error);
		doneDeferred.reject(error);
		stopDeferred.reject(error);
		if (!errorNotified) {
			errorNotified = true;
			try {
				options.onError?.(error);
			} catch {
				// Error observers must never break settlement.
			}
		}
	}

	function bufferedBytes(): number {
		let buffered = 0;
		if (socket && ready) {
			try {
				buffered = socket.bufferedAmount ?? 0;
			} catch {
				buffered = 0;
			}
		}
		return queuedBytes + buffered;
	}

	function sendBinary(bytes: Uint8Array): void {
		const active = socket;
		if (!active || !ready) return;
		try {
			active.send(bytes);
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	function flushQueue(): void {
		if (!ready || settled) return;
		for (const chunk of queue) sendBinary(chunk);
		queue.length = 0;
		queuedBytes = 0;
	}

	function handlePartial(event: XaiPartialEvent): void {
		const text = event.text.trim();
		if (event.speechFinal) {
			if (text) completed.push(text);
			lockedPrefix = "";
			interim = "";
		} else if (event.isFinal) {
			if (text) lockedPrefix = lockedPrefix ? `${lockedPrefix} ${text}` : text;
			interim = "";
		} else {
			interim = text;
		}
		emitPartial();
	}

	function handleDone(text: string): void {
		const trimmed = text.trim();
		if (trimmed) completed.push(trimmed);
		else if (lockedPrefix) completed.push(lockedPrefix);
		lockedPrefix = "";
		interim = "";
		if (settled) return;
		settled = true;
		cleanupSocket();
		doneDeferred.resolve();
		stopDeferred.resolve(completed.join(" "));
	}

	function handleMessage(data: unknown): void {
		if (typeof data !== "string") {
			fail(new Error("xAI STT returned an unexpected binary frame."));
			return;
		}
		const parsed = parseXaiEvent(data);
		switch (parsed.kind) {
			case "created":
				return;
			case "partial":
				if (!settled) handlePartial(parsed.event);
				return;
			case "done":
				handleDone(parsed.text);
				return;
			case "error":
				fail(new Error(`xAI STT error: ${parsed.message}`));
				return;
			case "unknown":
				return;
			case "malformed":
				fail(new Error(parsed.message));
				return;
		}
	}

	function closeBeforeDone(code: number, reason: string | undefined): void {
		const detail = reason ? `: ${reason}` : "";
		fail(new Error(`xAI STT connection closed before completion (${code})${detail}`));
	}

	async function connectWithKey(key: string): Promise<void> {
		const url = buildXaiSttUrl(options.baseURL, options.language);
		const headers = { ...options.headers, Authorization: `Bearer ${key}` };
		const wsOptions = {
			headers,
			proxy: getProxyForUrl(options.provider, new URL(url.toString())),
		} satisfies Bun.WebSocketOptions;
		const active = factory(url.toString(), wsOptions);
		active.binaryType = "nodebuffer";
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let attemptSettled = false;
		const settleReject = (error: Error): void => {
			if (attemptSettled) return;
			attemptSettled = true;
			try {
				active.close(1000, "aborted");
			} catch {
				// Already gone.
			}
			reject(error);
		};
		const settleResolve = (): void => {
			if (attemptSettled) return;
			attemptSettled = true;
			resolve();
		};
		const openTimer = setTimeout(() => {
			settleReject(new Error("xAI STT connection timed out."));
		}, XAI_CONNECT_TIMEOUT_MS);
		openTimer.unref?.();
		let createdTimer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = (): void => {
			clearTimeout(openTimer);
			clearTimeout(createdTimer);
			settleReject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
		};
		if (signal?.aborted) {
			onAbort();
		} else {
			signal?.addEventListener("abort", onAbort, { once: true });
		}
		active.onopen = () => {
			if (attemptSettled) {
				try {
					active.close(1000, "stale");
				} catch {
					// Already gone.
				}
				return;
			}
			clearTimeout(openTimer);
			createdTimer = setTimeout(() => {
				settleReject(new Error("xAI STT timed out waiting for transcript.created."));
			}, XAI_CREATED_TIMEOUT_MS);
			createdTimer.unref?.();
			active.onmessage = event => {
				const data: unknown = (event as MessageEvent).data;
				if (typeof data !== "string") {
					clearTimeout(createdTimer);
					settleReject(new Error("xAI STT returned an unexpected binary frame."));
					return;
				}
				const parsed = parseXaiEvent(data);
				if (parsed.kind === "created") {
					clearTimeout(createdTimer);
					socket = active;
					active.onmessage = liveEvent => handleMessage((liveEvent as MessageEvent).data);
					active.onerror = () => {
						if (!settled && !ready) readyDeferred.reject(new Error("xAI STT connection failed."));
					};
					active.onclose = closeEvent => {
						const ev = closeEvent as CloseEvent;
						if (!settled) closeBeforeDone(ev.code, ev.reason || undefined);
					};
					ready = true;
					readyDeferred.resolve();
					flushQueue();
					settleResolve();
					return;
				}
				if (parsed.kind === "error") {
					clearTimeout(createdTimer);
					const status = /401|unauthorized/i.test(parsed.message)
						? 401
						: /403|forbidden/i.test(parsed.message)
							? 403
							: undefined;
					settleReject(
						status !== undefined
							? new XaiSttConnectError(status, `xAI STT connection failed (${status}): ${parsed.message}`)
							: new Error(`xAI STT error: ${parsed.message}`),
					);
					return;
				}
				if (parsed.kind === "malformed") {
					clearTimeout(createdTimer);
					settleReject(new Error(parsed.message));
				}
				// Partials/done cannot arrive before created; unknown types ignored.
			};
			active.onclose = event => {
				const ev = event as CloseEvent;
				clearTimeout(createdTimer);
				const authStatus = parseCloseAuthStatus(ev.code);
				if (authStatus !== undefined) {
					settleReject(
						new XaiSttConnectError(authStatus, `xAI STT connection failed (${authStatus}): closed (${ev.code})`),
					);
				} else {
					settleReject(new Error(`xAI STT connection closed before ready (${ev.code})`));
				}
			};
		};
		active.onclose = event => {
			const ev = event as CloseEvent;
			clearTimeout(openTimer);
			const authStatus = parseCloseAuthStatus(ev.code);
			if (authStatus !== undefined) {
				settleReject(
					new XaiSttConnectError(authStatus, `xAI STT connection failed (${authStatus}): closed (${ev.code})`),
				);
			} else {
				settleReject(new Error(`xAI STT connection closed before ready (${ev.code})`));
			}
		};
		try {
			await promise;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(openTimer);
			clearTimeout(createdTimer);
		}
	}

	// Auth retry applies only to the pre-audio readiness handshake: once the
	// first audio byte flows, the bearer is fixed for the recording.
	void withAuth(options.apiKey, key => connectWithKey(key), { signal }).catch((error: unknown) => {
		if (!settled) fail(error instanceof Error ? error : new Error(String(error)));
	});

	const onSignalAbort = (): void => {
		if (settled) return;
		settled = true;
		const abortError = signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
		cleanupSocket();
		queue.length = 0;
		queuedBytes = 0;
		readyDeferred.reject(abortError);
		doneDeferred.reject(abortError);
		stopDeferred.resolve("");
	};
	if (signal?.aborted) onSignalAbort();
	else signal?.addEventListener("abort", onSignalAbort, { once: true });

	let stopStarted = false;

	return {
		pushAudio(audio: Float32Array): void {
			if (settled || stopping || audio.length === 0) return;
			let encoded: Uint8Array;
			try {
				encoded = encodePcm16(audio);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			if (ready && queue.length === 0) {
				if (bufferedBytes() + encoded.byteLength > XAI_MAX_BUFFERED_BYTES) {
					fail(new Error("xAI STT send buffer overflow."));
					return;
				}
				sendBinary(encoded);
				return;
			}
			if (queuedBytes + encoded.byteLength > XAI_MAX_BUFFERED_BYTES) {
				fail(new Error("xAI STT send buffer overflow."));
				return;
			}
			queue.push(encoded);
			queuedBytes += encoded.byteLength;
		},
		stop(): Promise<string> {
			if (stopStarted) return stopDeferred.promise;
			stopStarted = true;
			void (async () => {
				if (settled) return;
				stopping = true;
				try {
					await readyDeferred.promise;
				} catch (error) {
					if (!settled) fail(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				if (settled) return;
				flushQueue();
				const active = socket;
				if (!active || !ready) {
					fail(new Error("xAI STT connection is not ready."));
					return;
				}
				if (!doneSent) {
					doneSent = true;
					try {
						active.send('{"type":"audio.done"}');
					} catch (error) {
						fail(error instanceof Error ? error : new Error(String(error)));
						return;
					}
				}
				const finishTimer = setTimeout(() => {
					fail(new Error("xAI STT timed out waiting for transcript.done."));
				}, XAI_FINISH_TIMEOUT_MS);
				finishTimer.unref?.();
				try {
					await doneDeferred.promise;
				} catch {
					// Failure already recorded via fail().
				} finally {
					clearTimeout(finishTimer);
				}
			})();
			return stopDeferred.promise;
		},
		cancel(): void {
			if (settled) return;
			settled = true;
			stopping = true;
			signal?.removeEventListener("abort", onSignalAbort);
			cleanupSocket();
			queue.length = 0;
			queuedBytes = 0;
			readyDeferred.reject(new DOMException("Aborted", "AbortError"));
			doneDeferred.reject(new DOMException("Aborted", "AbortError"));
			stopDeferred.resolve("");
		},
	};
}
