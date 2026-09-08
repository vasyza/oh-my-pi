import { type FetchImpl, type OAuthAccess, type OAuthAccessSource, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import { logger } from "@oh-my-pi/pi-utils";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADERS,
	OPENAI_HEADER_VALUES,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { encodePcm16, encodeWavFromPcm16 } from "../tts/wav";
import type { SttStreamHandle } from "./asr-client";
import type { CloudSttOptions } from "./cloud";

export interface CodexSttOptions extends CloudSttOptions {
	authStorage: OAuthAccessSource;
	sessionId: string;
	access: OAuthAccess;
	baseURL: string;
	headers?: Record<string, string>;
	fetch?: FetchImpl;
}

const CODEX_READY_TIMEOUT_MS = 10_000;
const CODEX_FINISH_TIMEOUT_MS = 8_000;
const CODEX_BATCH_TIMEOUT_MS = 60_000;
const CODEX_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const CODEX_MAX_CLIP_BYTES = 24_000 * 2 * 300;
const CODEX_SAMPLE_RATE = 24_000;
const CODEX_SIGNAL_RMS = 0.003;
const CODEX_ERROR_BODY_LIMIT = 2_048;

type CodexSttEvent =
	| { kind: "started" }
	| { kind: "updated"; status: string }
	| { kind: "segment"; utterance: string; revision: number; text: string }
	| { kind: "final"; utterance: string; revision: number; text: string }
	| { kind: "failed"; message: string }
	| { kind: "sessionError"; fatal: boolean; message: string }
	| { kind: "ignored" }
	| { kind: "malformed"; message: string };

function parseCodexEvent(raw: string): CodexSttEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			kind: "malformed",
			message: `Codex STT returned an invalid event payload: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "malformed", message: "Codex STT returned an invalid event payload." };
	}
	const type = "type" in parsed && typeof parsed.type === "string" ? parsed.type : undefined;
	switch (type) {
		case "session.started":
			return { kind: "started" };
		case "session.updated": {
			if (!("session" in parsed) || typeof parsed.session !== "object" || parsed.session === null) {
				return { kind: "malformed", message: "Codex STT returned a malformed session event." };
			}
			const status =
				"status" in parsed.session && typeof parsed.session.status === "string" ? parsed.session.status : undefined;
			if (status === undefined) {
				return { kind: "malformed", message: "Codex STT returned a malformed session event." };
			}
			return { kind: "updated", status };
		}
		case "transcript.segment":
		case "transcript.final": {
			const utterance =
				"utterance_id" in parsed && typeof parsed.utterance_id === "string" ? parsed.utterance_id : undefined;
			const revision = "revision" in parsed && typeof parsed.revision === "number" ? parsed.revision : undefined;
			const text = "text" in parsed && typeof parsed.text === "string" ? parsed.text : undefined;
			if (utterance === undefined || revision === undefined || text === undefined) {
				return { kind: "malformed", message: "Codex STT returned a malformed transcript event." };
			}
			return type === "transcript.segment"
				? { kind: "segment", utterance, revision, text }
				: { kind: "final", utterance, revision, text };
		}
		case "transcript.failed": {
			const error = "error" in parsed ? parsed.error : undefined;
			const message =
				typeof error === "object" &&
				error !== null &&
				"message" in error &&
				typeof error.message === "string" &&
				error.message
					? error.message
					: "transcription failed";
			return { kind: "failed", message };
		}
		case "session.error": {
			const fatal = "fatal" in parsed && typeof parsed.fatal === "boolean" ? parsed.fatal : undefined;
			const error = "error" in parsed ? parsed.error : undefined;
			const message =
				typeof error === "object" &&
				error !== null &&
				"message" in error &&
				typeof error.message === "string" &&
				error.message
					? error.message
					: "session error";
			if (fatal === undefined) {
				return { kind: "malformed", message: "Codex STT returned a malformed session error." };
			}
			return { kind: "sessionError", fatal, message };
		}
		case "speech.started":
		case "speech.stopped":
		case "transcript.delta":
			return { kind: "ignored" };
		default:
			// asset.* and any future event types never affect the transcript.
			return { kind: "ignored" };
	}
}

function buildDictationUrl(baseURL: string): URL {
	const normalized = baseURL.replace(/\/+$/, "") || CODEX_BASE_URL;
	let url: URL;
	try {
		url = new URL(`${normalized}/dictation/stream`);
	} catch {
		throw new Error(`Invalid Codex STT base URL: ${normalized}`);
	}
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	else throw new Error(`Unsupported Codex STT URL scheme: ${url.protocol}`);
	return url;
}

function sessionStartMessage(): string {
	return JSON.stringify({
		type: "session.start",
		config: {
			input_audio_format: "pcm16",
			sample_rate_hz: CODEX_SAMPLE_RATE,
			num_channels: 1,
			max_buffer_size_bytes: 4 * 1024 * 1024,
			max_utterance_duration_ms: 30_000,
			session_ttl_ms: 300_000,
			provider_mode: "streaming_sse",
			transcript_delivery_mode: "segment",
			vad: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
		},
	});
}

function boundedErrorBody(body: string, statusText: string): string {
	const normalized = body.trim().replaceAll(/\s+/g, " ");
	if (!normalized) return statusText || "empty response body";
	if (normalized.length <= CODEX_ERROR_BODY_LIMIT) return normalized;
	return `${normalized.slice(0, CODEX_ERROR_BODY_LIMIT)}…`;
}

interface UtteranceState {
	partial: { revision: number; text: string } | null;
	final: { revision: number; text: string } | null;
}

/**
 * Subscription dictation: JSON PCM16 streaming over
 * `wss://<base>/dictation/stream` with a same-provider WAV batch fallback.
 * Mirrors the shipped Desktop client: utterance-merged segment/final events,
 * `session.close` finish, batch of the full buffered clip when streaming fails
 * after audible speech.
 */
export function createCodexSttStream(options: CodexSttOptions): SttStreamHandle {
	const factory =
		options.webSocketFactory ??
		((url: string, wsOptions: Bun.WebSocketOptions) =>
			Reflect.construct(WebSocket, [url, wsOptions]) as Bun.WebSocket);
	const fetchImpl = options.fetch ?? fetch;
	const signal = options.signal;
	signal?.throwIfAborted();

	const clip: Uint8Array[] = [];
	let clipBytes = 0;
	let hasSignal = false;
	const utterances = new Map<string, UtteranceState>();
	let lastEmitted = "";

	let socket: Bun.WebSocket | null = null;
	let ready = false;
	let stopping = false;
	let settled = false;
	let closeSent = false;
	let batchPending = false;
	let batchError: Error | null = null;
	let errorNotified = false;

	const stopDeferred = Promise.withResolvers<string>();
	void stopDeferred.promise.catch(() => {});
	const readyDeferred = Promise.withResolvers<void>();
	void readyDeferred.promise.catch(() => {});
	const finishDeferred = Promise.withResolvers<void>();
	void finishDeferred.promise.catch(() => {});

	function previewText(): string {
		const parts: string[] = [];
		for (const entry of utterances.values()) {
			const text = entry.final?.text ?? entry.partial?.text ?? "";
			if (text) parts.push(text);
		}
		return parts.join(" ");
	}

	function finalText(): string {
		const parts: string[] = [];
		for (const entry of utterances.values()) {
			const text = entry.final?.text ?? "";
			if (text) parts.push(text);
		}
		return parts.join(" ");
	}

	function hasUnfinishedPartial(): boolean {
		for (const entry of utterances.values()) {
			if (!entry.final && entry.partial) return true;
		}
		return false;
	}

	function emitPartial(): void {
		const text = previewText();
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
		logger.debug("stt: Codex stream failed", {});
		readyDeferred.reject(error);
		finishDeferred.reject(error);
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

	function armBatchFallback(error: Error): void {
		if (settled || batchPending) return;
		batchPending = true;
		batchError = error;
		cleanupSocket();
		readyDeferred.reject(error);
		finishDeferred.reject(error);
		try {
			options.onStatus?.("OpenAI streaming unavailable; transcription will finish after recording.");
		} catch {
			// Status observers must never break the stream.
		}
	}

	function applySegment(utterance: string, revision: number, text: string): void {
		let entry = utterances.get(utterance);
		if (!entry) {
			entry = { partial: null, final: null };
			utterances.set(utterance, entry);
		}
		if (entry.final) return;
		if (!entry.partial || revision >= entry.partial.revision) {
			entry.partial = { revision, text };
			emitPartial();
		}
	}

	function applyFinal(utterance: string, revision: number, text: string): void {
		let entry = utterances.get(utterance);
		if (!entry) {
			entry = { partial: null, final: null };
			utterances.set(utterance, entry);
		}
		if (!entry.final || revision >= entry.final.revision) {
			entry.final = { revision, text };
			entry.partial = null;
			emitPartial();
		}
	}

	function handleMessage(data: unknown): void {
		if (typeof data !== "string") {
			armBatchFallback(new Error("Codex STT returned an unexpected binary frame."));
			return;
		}
		const parsed = parseCodexEvent(data);
		switch (parsed.kind) {
			case "started":
				if (!ready) {
					ready = true;
					readyDeferred.resolve();
					drainPending();
				}
				return;
			case "updated":
				if (parsed.status === "closed") {
					if (stopping) {
						finishDeferred.resolve();
					} else {
						armBatchFallback(new Error("Codex STT session closed unexpectedly."));
					}
				}
				return;
			case "segment":
				if (!settled) applySegment(parsed.utterance, parsed.revision, parsed.text);
				return;
			case "final":
				if (!settled) applyFinal(parsed.utterance, parsed.revision, parsed.text);
				return;
			case "failed":
				armBatchFallback(new Error(`Codex STT error: ${parsed.message}`));
				return;
			case "sessionError":
				if (parsed.fatal) armBatchFallback(new Error(`Codex STT error: ${parsed.message}`));
				return;
			case "ignored":
				return;
			case "malformed":
				armBatchFallback(new Error(parsed.message));
				return;
		}
	}

	const pendingAppends: string[] = [];
	let pendingBytes = 0;

	function drainPending(): void {
		if (!ready || settled || batchPending) return;
		const active = socket;
		if (!active) return;
		for (const payload of pendingAppends) {
			try {
				active.send(payload);
			} catch (error) {
				armBatchFallback(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
		pendingAppends.length = 0;
		pendingBytes = 0;
	}

	function sendAppend(payload: string): void {
		if (!ready || batchPending || settled) return;
		const active = socket;
		if (!active) return;
		let buffered = 0;
		try {
			buffered = active.bufferedAmount ?? 0;
		} catch {
			buffered = 0;
		}
		if (buffered + payload.length > CODEX_MAX_BUFFERED_BYTES) {
			armBatchFallback(new Error("Codex STT send buffer overflow."));
			return;
		}
		try {
			active.send(payload);
		} catch (error) {
			armBatchFallback(error instanceof Error ? error : new Error(String(error)));
		}
	}

	function connect(): void {
		let url: URL;
		try {
			url = buildDictationUrl(options.baseURL);
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const protocols = ["chatgpt-dictation", `openai-bearer.${options.access.accessToken}`, "codex-desktop"];
		const { Authorization: _droppedAuth, ...restHeaders } = options.headers ?? {};
		const wsOptions = {
			protocols,
			headers: restHeaders,
			proxy: getProxyForUrl("openai-codex", new URL(url.toString())),
		} satisfies Bun.WebSocketOptions;
		let active: Bun.WebSocket;
		try {
			active = factory(url.toString(), wsOptions);
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		socket = active;
		active.binaryType = "nodebuffer";
		const openTimer = setTimeout(() => {
			armBatchFallback(new Error("Codex STT timed out before session.start completed."));
		}, CODEX_READY_TIMEOUT_MS);
		openTimer.unref?.();
		const onAbort = (): void => {
			clearTimeout(openTimer);
		};
		if (!signal?.aborted) signal?.addEventListener("abort", onAbort, { once: true });
		active.onopen = () => {
			if (settled || batchPending) {
				clearTimeout(openTimer);
				try {
					active.close(1000, "stale");
				} catch {
					// Already gone.
				}
				return;
			}
			try {
				active.send(sessionStartMessage());
			} catch (error) {
				clearTimeout(openTimer);
				armBatchFallback(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		};
		active.onmessage = event => {
			clearTimeout(openTimer);
			handleMessage((event as MessageEvent).data);
		};
		active.onerror = () => {
			// Detail arrives via close or stays pending until the ready timer.
		};
		active.onclose = event => {
			const ev = event as CloseEvent;
			clearTimeout(openTimer);
			signal?.removeEventListener("abort", onAbort);
			if (settled || batchPending) return;
			if (stopping && closeSent && ev.code === 1000) {
				finishDeferred.resolve();
				return;
			}
			armBatchFallback(new Error(`Codex STT connection closed before completion (${ev.code})`));
		};
	}

	connect();

	const onSignalAbort = (): void => {
		if (settled) return;
		settled = true;
		const abortError = signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
		cleanupSocket();
		readyDeferred.reject(abortError);
		finishDeferred.reject(abortError);
		stopDeferred.resolve("");
	};
	if (signal?.aborted) onSignalAbort();
	else signal?.addEventListener("abort", onSignalAbort, { once: true });

	async function runBatch(abortedCheck: () => boolean): Promise<string> {
		const wav = encodeWavFromPcm16(clip, CODEX_SAMPLE_RATE);
		clip.length = 0;
		clipBytes = 0;
		const timeoutSignal = AbortSignal.timeout(CODEX_BATCH_TIMEOUT_MS);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const proxiedFetch = wrapFetchForProxy(fetchImpl, "openai-codex");
		const base = options.baseURL.replace(/\/+$/, "") || CODEX_BASE_URL;
		const url = `${base}/transcribe`;
		return await withOAuthAccess(
			options.authStorage,
			"openai-codex",
			async access => {
				if (abortedCheck()) throw new DOMException("Aborted", "AbortError");
				const headers: Record<string, string> = { ...options.headers };
				delete headers.Authorization;
				delete headers.authorization;
				delete headers[OPENAI_HEADERS.ACCOUNT_ID];
				delete headers[OPENAI_HEADERS.ACCOUNT_ID.toLowerCase()];
				headers.Authorization = `Bearer ${access.accessToken}`;
				const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
				if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
				applyCodexResidencyHeader(headers, access.accessToken);
				headers[OPENAI_HEADERS.ORIGINATOR] = OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
				const form = new FormData();
				form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
				const response = await proxiedFetch(url, { method: "POST", headers, body: form, signal: combinedSignal });
				if (!response.ok) {
					const body = await response.text().catch(() => "");
					const statusError = new Error(
						`Codex STT batch failed (${response.status}): ${boundedErrorBody(body, response.statusText)}`,
					) as Error & { status: number };
					statusError.status = response.status;
					throw statusError;
				}
				let payload: unknown;
				try {
					payload = await response.json();
				} catch {
					throw new Error("Codex STT batch returned an invalid response.");
				}
				const text =
					typeof payload === "object" && payload !== null && "text" in payload ? payload.text : undefined;
				if (typeof text !== "string") throw new Error("Codex STT batch returned an invalid response.");
				return text.trim();
			},
			{ sessionId: options.sessionId, signal: combinedSignal, seed: options.access },
		);
	}

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
			if (!hasSignal) {
				let sum = 0;
				for (let i = 0; i < audio.length; i += 1) {
					const sample = audio[i]!;
					sum += sample * sample;
				}
				if (Math.sqrt(sum / audio.length) >= CODEX_SIGNAL_RMS) hasSignal = true;
			}
			if (clipBytes + encoded.byteLength > CODEX_MAX_CLIP_BYTES) {
				fail(new Error("Cloud dictation reached the 5-minute recording limit."));
				return;
			}
			clip.push(encoded);
			clipBytes += encoded.byteLength;
			if (batchPending) return;
			const payload = JSON.stringify({
				type: "audio.append",
				audio: Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength).toString("base64"),
			});
			if (!ready) {
				if (pendingBytes + payload.length > CODEX_MAX_BUFFERED_BYTES) {
					armBatchFallback(new Error("Codex STT send buffer overflow."));
					return;
				}
				pendingAppends.push(payload);
				pendingBytes += payload.length;
				return;
			}
			sendAppend(payload);
		},
		stop(): Promise<string> {
			if (stopStarted) return stopDeferred.promise;
			stopStarted = true;
			void (async () => {
				if (settled) return;
				stopping = true;
				if (!batchPending) {
					try {
						await readyDeferred.promise;
					} catch (error) {
						if (!batchPending && !settled) {
							armBatchFallback(error instanceof Error ? error : new Error(String(error)));
						}
					}
				}
				if (!settled && !batchPending) {
					drainPending();
					const active = socket;
					if (!active || !ready) {
						armBatchFallback(new Error("Codex STT connection is not ready."));
					} else {
						closeSent = true;
						try {
							active.send(JSON.stringify({ type: "session.close" }));
						} catch (error) {
							armBatchFallback(error instanceof Error ? error : new Error(String(error)));
						}
						if (!batchPending) {
							const finishTimer = setTimeout(() => {
								armBatchFallback(new Error("Codex STT timed out while closing the session."));
							}, CODEX_FINISH_TIMEOUT_MS);
							finishTimer.unref?.();
							try {
								await finishDeferred.promise;
							} catch {
								// Batch fallback already armed.
							} finally {
								clearTimeout(finishTimer);
							}
						}
					}
				}
				if (settled) return;
				if (batchPending) {
					if (signal?.aborted || !hasSignal || clip.length === 0) {
						const original = batchError ?? new Error("Codex STT streaming failed.");
						fail(original);
						return;
					}
					try {
						const text = await runBatch(() => signal?.aborted === true);
						if (settled) return;
						settled = true;
						cleanupSocket();
						if (text) {
							lastEmitted = text;
							try {
								options.onPartial?.(text);
							} catch {
								// Preview observers must never break settlement.
							}
						}
						stopDeferred.resolve(text);
					} catch (error) {
						if (!settled) fail(error instanceof Error ? error : new Error(String(error)));
					}
					return;
				}
				if (hasUnfinishedPartial()) {
					// Successful close but only provisional segments: recover via batch.
					if (!hasSignal || clip.length === 0) {
						settled = true;
						cleanupSocket();
						stopDeferred.resolve(finalText());
						return;
					}
					try {
						const text = await runBatch(() => signal?.aborted === true);
						if (settled) return;
						settled = true;
						cleanupSocket();
						stopDeferred.resolve(text);
					} catch (error) {
						if (!settled) fail(error instanceof Error ? error : new Error(String(error)));
					}
					return;
				}
				settled = true;
				cleanupSocket();
				stopDeferred.resolve(finalText());
			})();
			return stopDeferred.promise;
		},
		cancel(): void {
			if (settled) return;
			settled = true;
			stopping = true;
			signal?.removeEventListener("abort", onSignalAbort);
			cleanupSocket();
			clip.length = 0;
			clipBytes = 0;
			readyDeferred.reject(new DOMException("Aborted", "AbortError"));
			finishDeferred.reject(new DOMException("Aborted", "AbortError"));
			stopDeferred.resolve("");
		},
	};
}
