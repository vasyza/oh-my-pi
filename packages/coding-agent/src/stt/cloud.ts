import { type FetchImpl, seedApiKeyResolver, type ApiKey } from "@oh-my-pi/pi-ai";
import { resolveCodexResponsesUrl } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";
import type { ModelRegistry } from "../config/model-registry";
import { resolveXAIHttpCredentials, resolveXAIHttpTransport } from "../lib/xai-http";
import { createCodexSttStream } from "./codex";
import type { SttStreamHandle } from "./asr-client";
import { createXaiSttStream } from "./xai";

/** Cloud dictation backend selected explicitly via `stt.provider`. */
export type CloudSttProvider = "xai" | "openai-codex";

export interface CloudSttContext {
	modelRegistry: ModelRegistry;
	sessionId: string;
}

export interface CloudSttOptions {
	language?: string;
	signal?: AbortSignal;
	/** Whole-dictation replaceable preview text. Cloud backends never emit segments. */
	onPartial?: (text: string) => void;
	onError?: (error: Error) => void;
	onStatus?: (message: string) => void;
	/** Scoped socket factory for tests; production uses the global WebSocket. */
	webSocketFactory?: (url: string, options: Bun.WebSocketOptions) => Bun.WebSocket;
	/** Scoped fetch for tests; production uses the global fetch. */
	fetch?: FetchImpl;
}

/** Parse an explicit `stt.provider` value; returns undefined for local/unknown. */
export function parseCloudSttProvider(value: string | undefined): CloudSttProvider | undefined {
	if (value === "xai" || value === "openai-codex") return value;
	return undefined;
}

/**
 * Open a cloud dictation stream for an explicitly selected provider. Resolves
 * credentials first and returns the handle while socket readiness continues in
 * the background, so capture can start without losing leading speech.
 * Local STT never routes here; unknown providers throw before any capture.
 */
export async function startCloudSttStream(
	context: CloudSttContext,
	provider: CloudSttProvider,
	options: CloudSttOptions = {},
): Promise<SttStreamHandle> {
	options.signal?.throwIfAborted();
	if (provider === "xai") {
		const creds = await resolveXAIHttpCredentials(context.modelRegistry, undefined, {
			sessionId: context.sessionId,
			signal: options.signal,
		});
		if (!creds) {
			throw new Error("No xAI credentials. Run /login → xAI Grok OAuth or configure XAI_API_KEY.");
		}
		const transport = resolveXAIHttpTransport(context.modelRegistry, creds.provider);
		const apiKey: ApiKey = seedApiKeyResolver(
			creds.apiKey,
			context.modelRegistry.resolver(creds.provider, {
				sessionId: context.sessionId,
				baseUrl: creds.baseURL,
			}),
		);
		return createXaiSttStream({
			...options,
			provider: creds.provider,
			apiKey,
			baseURL: transport.baseURL,
			headers: transport.headers,
		});
	}
	const access = await context.modelRegistry.authStorage.getOAuthAccess("openai-codex", context.sessionId, {
		signal: options.signal,
	});
	if (!access) {
		throw new Error("No Codex OAuth credential is available for speech-to-text. Run /login → OpenAI Codex.");
	}
	const responsesUrl = resolveCodexResponsesUrl(context.modelRegistry.getProviderBaseUrl("openai-codex"));
	const baseURL = responsesUrl.endsWith("/codex/responses")
		? responsesUrl.slice(0, -"/codex/responses".length)
		: responsesUrl;
	return createCodexSttStream({
		...options,
		authStorage: context.modelRegistry.authStorage,
		sessionId: context.sessionId,
		access,
		baseURL: baseURL || CODEX_BASE_URL,
		headers: context.modelRegistry.getProviderHeaders("openai-codex"),
	});
}
