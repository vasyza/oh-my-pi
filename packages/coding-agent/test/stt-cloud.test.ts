import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings, settings } from "../src/config/settings";
import * as asrClient from "../src/stt/asr-client";
import { STTController } from "../src/stt/stt-controller";
import * as downloader from "../src/stt/downloader";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// Real time is intentional where loopback sockets are involved: Bun WebSocket
// upgrade and delivery are not driven by fake timers (mcp-http-transport.test.ts
// precedent). Credential-resolution races use deferred promises, not sleeps.

function makeEditor() {
	return {
		insertText: vi.fn(),
		setVolatileText: vi.fn(),
		clearVolatileText: vi.fn(),
		commitVolatileText: vi.fn(),
		submit: vi.fn(),
		deleteBeforeCursor: vi.fn(),
	};
}

function makeOptions() {
	return {
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		onStateChange: vi.fn(),
		requestRender: vi.fn(),
	};
}

function fakeXaiRegistry(baseURL: string, key: string | undefined): ModelRegistry {
	return {
		authStorage: { hasNonEnvCredential: () => false },
		getApiKeyForProvider: async () => key,
		getProviderBaseUrl: () => baseURL,
		getProviderHeaders: () => undefined,
		resolver: () => async () => key,
	} as unknown as ModelRegistry;
}

function fakeCodexRegistry(
	baseURL: string,
	access: { accessToken: string; accountId?: string } | undefined,
): ModelRegistry {
	return {
		authStorage: {
			getOAuthAccess: async () => access,
			rotateSessionCredential: async () => false,
		},
		getProviderBaseUrl: () => baseURL,
		getProviderHeaders: () => undefined,
	} as unknown as ModelRegistry;
}

function startXaiDictation(
	onDone: (ws: Bun.ServerWebSocket<undefined>) => void,
	onBinary?: (ws: Bun.ServerWebSocket<undefined>) => void,
): {
	server: Bun.Server<undefined>;
	url: string;
} {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			if (new URL(req.url).pathname === "/stt" && srv.upgrade(req)) {
				return undefined as unknown as Response;
			}
			return new Response("nope", { status: 404 });
		},
		websocket: {
			open(ws) {
				ws.send(JSON.stringify({ type: "transcript.created" }));
			},
			message(ws, message) {
				if (typeof message !== "string") {
					onBinary?.(ws);
					return;
				}
				if (JSON.parse(message).type === "audio.done") onDone(ws);
			},
		},
	});
	return { server, url: `http://127.0.0.1:${server.port}` };
}

function startCodexDictation(): { server: Bun.Server<undefined>; url: string } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			if (new URL(req.url).pathname === "/dictation/stream" && srv.upgrade(req)) {
				return undefined as unknown as Response;
			}
			return new Response("nope", { status: 404 });
		},
		websocket: {
			message(ws, message) {
				if (typeof message !== "string") return;
				const parsed = JSON.parse(message) as { type?: string };
				if (parsed.type === "session.start") {
					ws.send(
						JSON.stringify({
							type: "session.started",
							sequence_no: 1,
							session: {
								session_id: "s",
								status: "active",
								config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" },
							},
						}),
					);
					return;
				}
				if (parsed.type === "session.close") {
					ws.send(
						JSON.stringify({
							type: "transcript.final",
							sequence_no: 2,
							utterance_id: "u",
							revision: 1,
							text: "Codex finals.",
						}),
					);
					ws.send(
						JSON.stringify({
							type: "session.updated",
							sequence_no: 3,
							session: {
								session_id: "s",
								status: "closed",
								config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" },
							},
						}),
					);
				}
			},
		},
	});
	return { server, url: `http://127.0.0.1:${server.port}` };
}

describe("STTController cloud backends", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;
	let servers: Bun.Server<undefined>[] = [];

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.modelName", "fast");
		settings.set("stt.submitTrigger", "never");
		servers = [];
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		for (const server of servers) server.stop(true);
		restoreSettingsTestState(state);
		vi.restoreAllMocks();
	});

	interface CloudCaptureHarness {
		factory: (rate: number, callback: (error: Error | null, samples: Float32Array) => void) => { stop: () => void };
		rates: number[];
		stop: Mock<() => void>;
		feed: (samples: Float32Array) => void;
		fail: (error: Error) => void;
	}

	function trackCapture(): CloudCaptureHarness {
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const rates: number[] = [];
		const stop = vi.fn();
		const factory = (rate: number, callback: (error: Error | null, samples: Float32Array) => void) => {
			rates.push(rate);
			onAudio = callback;
			return { stop };
		};
		return {
			factory,
			rates,
			stop,
			feed: (samples: Float32Array) => onAudio?.(null, samples),
			fail: (error: Error) => onAudio?.(error, new Float32Array()),
		};
	}

	it("records through xAI without touching the local model cache or worker", async () => {
		const { server, url } = startXaiDictation(ws => {
			ws.send(
				JSON.stringify({ type: "transcript.partial", text: "Hello cloud.", is_final: true, speech_final: true }),
			);
			ws.send(JSON.stringify({ type: "transcript.done", text: "And more." }));
		});
		servers.push(server);
		settings.set("stt.provider", "xai");

		const isCached = vi.spyOn(downloader, "isSttModelCached").mockRejectedValue(new Error("must not preflight"));
		const download = vi.spyOn(downloader, "downloadSttModel").mockRejectedValue(new Error("must not download"));
		const startStream = vi.spyOn(asrClient.sttClient, "startStream").mockImplementation(() => {
			throw new Error("must not use local worker");
		});
		const capture = trackCapture();
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({
			cloud: () => ({ modelRegistry: fakeXaiRegistry(url, "k"), sessionId: "sess" }),
			createCapture: capture.factory,
		});

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		expect(capture.rates).toEqual([16_000]);
		capture.feed(new Float32Array([0.2, -0.2]));
		await controller.toggle(editor, options);

		expect(controller.state).toBe("idle");
		expect(editor.commitVolatileText).toHaveBeenCalledWith("Hello cloud. And more.");
		expect(isCached).not.toHaveBeenCalled();
		expect(download).not.toHaveBeenCalled();
		expect(startStream).not.toHaveBeenCalled();
	});

	it("never opens the mic without credentials or with an unknown provider", async () => {
		const startStream = vi.spyOn(asrClient.sttClient, "startStream").mockImplementation(() => {
			throw new Error("must not use local worker");
		});
		// "silly" simulates a hand-edited config value outside the schema enum.
		const setRaw = settings.set.bind(settings) as (path: string, value: string) => void;
		try {
			for (const setup of [
				{
					provider: "xai",
					cloud: () => ({ modelRegistry: fakeXaiRegistry("http://127.0.0.1:1", undefined), sessionId: "s" }),
					warning: /No xAI credentials/,
				},
				{
					provider: "openai-codex",
					cloud: () => ({ modelRegistry: fakeCodexRegistry("http://127.0.0.1:1", undefined), sessionId: "s" }),
					warning: /No Codex OAuth/,
				},
				{
					provider: "silly",
					cloud: () => ({ modelRegistry: fakeXaiRegistry("http://127.0.0.1:1", "k"), sessionId: "s" }),
					warning: /Unknown speech provider/,
				},
			] as const) {
				setRaw("stt.provider", setup.provider);
				const capture = trackCapture();
				const editor = makeEditor();
				const options = makeOptions();
				controller?.dispose();
				controller = new STTController({ cloud: setup.cloud, createCapture: capture.factory });
				await controller.toggle(editor, options);
				expect(controller.state).toBe("idle");
				expect(capture.rates).toHaveLength(0);
				expect(options.showWarning).toHaveBeenCalledWith(expect.stringMatching(setup.warning));
				controller.dispose();
				controller = undefined;
			}
			expect(startStream).not.toHaveBeenCalled();
		} finally {
			controller?.dispose();
			controller = undefined;
		}
	});

	it("still runs the local preflight after switching back from cloud", async () => {
		const { server, url } = startXaiDictation(ws => {
			ws.send(JSON.stringify({ type: "transcript.done", text: "hi" }));
		});
		servers.push(server);

		settings.set("stt.provider", "xai");
		const capture = trackCapture();
		controller = new STTController({
			cloud: () => ({ modelRegistry: fakeXaiRegistry(url, "k"), sessionId: "s" }),
			createCapture: capture.factory,
		});
		const editor = makeEditor();
		await controller.toggle(editor, makeOptions());
		capture.feed(new Float32Array([0.1]));
		await controller.toggle(editor, makeOptions());
		expect(editor.commitVolatileText).toHaveBeenCalledWith("hi");

		settings.set("stt.provider", "local");
		const isCached = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		const stopped = vi.fn().mockResolvedValue("");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: stopped,
			cancel: vi.fn(),
		});
		await controller.toggle(editor, makeOptions());
		expect(controller.state).toBe("recording");
		expect(isCached).toHaveBeenCalledWith("fast");
	});

	it("release during cloud auth resolve never opens a late mic", async () => {
		const { server, url } = startXaiDictation(ws => {
			ws.send(JSON.stringify({ type: "transcript.done", text: "late" }));
		});
		servers.push(server);
		settings.set("stt.provider", "xai");

		let releaseKey: ((key: string | undefined) => void) | undefined;
		const gate = new Promise<string | undefined>(resolve => {
			releaseKey = resolve;
		});
		const capture = trackCapture();
		const editor = makeEditor();
		controller = new STTController({
			cloud: () => ({
				modelRegistry: {
					...fakeXaiRegistry(url, "k"),
					getApiKeyForProvider: () => gate,
				} as unknown as ModelRegistry,
				sessionId: "s",
			}),
			createCapture: capture.factory,
		});

		const first = controller.toggle(editor, makeOptions());
		// Release while the credential fetch is still pending.
		await controller.toggle(editor, makeOptions());
		releaseKey!("k");
		await first;

		expect(capture.rates).toHaveLength(0);
		expect(controller.state).toBe("idle");

		// The cancelled latch does not stick: the next gesture records.
		await controller.toggle(editor, makeOptions());
		expect(controller.state).toBe("recording");
		expect(capture.rates).toEqual([16_000]);
	});

	it("keeps the last cloud preview as an editable draft on terminal error without submitting", async () => {
		const { server, url } = startXaiDictation(
			ws => {
				ws.send(JSON.stringify({ type: "error", message: "boom" }));
			},
			ws => {
				ws.send(
					JSON.stringify({
						type: "transcript.partial",
						text: "partial words here",
						is_final: false,
						speech_final: false,
					}),
				);
			},
		);
		servers.push(server);
		settings.set("stt.provider", "xai");
		settings.set("stt.submitTrigger", "release");

		const capture = trackCapture();
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({
			cloud: () => ({ modelRegistry: fakeXaiRegistry(url, "k"), sessionId: "s" }),
			createCapture: capture.factory,
		});
		await controller.toggle(editor, options);
		capture.feed(new Float32Array([0.2]));
		await Bun.sleep(150);
		expect(editor.setVolatileText).toHaveBeenCalledWith("partial words here");
		await controller.toggle(editor, options);

		expect(controller.state).toBe("idle");
		expect(editor.commitVolatileText).toHaveBeenCalledWith("partial words here");
		expect(editor.submit).not.toHaveBeenCalled();
		expect(options.showWarning).toHaveBeenCalledTimes(1);
		expect(options.showWarning).toHaveBeenCalledWith(expect.stringContaining("boom"));
	});

	it("applies the submit trigger once on cloud success", async () => {
		const { server, url } = startXaiDictation(ws => {
			ws.send(JSON.stringify({ type: "transcript.done", text: "hello world" }));
		});
		servers.push(server);
		settings.set("stt.provider", "xai");
		settings.set("stt.submitTrigger", "release");

		const capture = trackCapture();
		const editor = makeEditor();
		controller = new STTController({
			cloud: () => ({ modelRegistry: fakeXaiRegistry(url, "k"), sessionId: "s" }),
			createCapture: capture.factory,
		});
		await controller.toggle(editor, makeOptions());
		capture.feed(new Float32Array([0.2]));
		await controller.toggle(editor, makeOptions());

		expect(editor.commitVolatileText).toHaveBeenCalledTimes(1);
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("captures Codex at 24 kHz and finishes when stop races readiness", async () => {
		const { server, url } = startCodexDictation();
		servers.push(server);
		settings.set("stt.provider", "openai-codex");

		const capture = trackCapture();
		const editor = makeEditor();
		controller = new STTController({
			cloud: () => ({
				modelRegistry: fakeCodexRegistry(url, { accessToken: "tok", accountId: "acc" }),
				sessionId: "s",
			}),
			createCapture: capture.factory,
		});
		await controller.toggle(editor, makeOptions());
		expect(capture.rates).toEqual([24_000]);
		capture.feed(new Float32Array([0.2]));
		await controller.toggle(editor, makeOptions());

		expect(controller.state).toBe("idle");
		expect(editor.commitVolatileText).toHaveBeenCalledWith("Codex finals.");
	});

	it("surfaces microphone failures during cloud recording without a cloud warning", async () => {
		const { server, url } = startXaiDictation(() => {});
		servers.push(server);
		settings.set("stt.provider", "xai");

		const capture = trackCapture();
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({
			cloud: () => ({ modelRegistry: fakeXaiRegistry(url, "k"), sessionId: "s" }),
			createCapture: capture.factory,
		});
		await controller.toggle(editor, options);
		capture.fail(new Error("Microphone permission denied"));

		expect(controller.state).toBe("idle");
		expect(capture.stop).toHaveBeenCalledTimes(1);
		expect(editor.clearVolatileText).toHaveBeenCalled();
		expect(options.showWarning).toHaveBeenCalledWith("Microphone permission denied");
	});

	/** A cloud start parked in credential resolution, with the release valve in the test's hand. */
	function gatedXaiController(url: string, capture: CloudCaptureHarness) {
		let releaseKey: ((key: string | undefined) => void) | undefined;
		const gate = new Promise<string | undefined>(resolve => {
			releaseKey = resolve;
		});
		const controller = new STTController({
			cloud: () => ({
				modelRegistry: {
					...fakeXaiRegistry(url, "k"),
					getApiKeyForProvider: () => gate,
				} as unknown as ModelRegistry,
				sessionId: "s",
			}),
			createCapture: capture.factory,
		});
		return { controller, release: (key: string | undefined) => releaseKey?.(key) };
	}

	it("does not let the hold trigger cancel a latched cloud start in flight", async () => {
		const { server, url } = startXaiDictation(ws => {
			ws.send(JSON.stringify({ type: "transcript.done", text: "latched" }));
		});
		servers.push(server);
		settings.set("stt.provider", "xai");
		const capture = trackCapture();
		const gated = gatedXaiController(url, capture);
		controller = gated.controller;
		const editor = makeEditor();
		const options = makeOptions();

		// The latch's start is parked; the push-to-talk release arrives while it is in flight and must
		// not cancel the session the user just asked for.
		const starting = gated.controller.toggle(editor, { ...options, trigger: "handsFree" });
		await gated.controller.toggle(editor, { ...options, trigger: "hold" });
		gated.release("k");
		await starting;

		expect(controller.state).toBe("recording");
		expect(controller.handsFreeActive).toBe(true);
		expect(capture.rates).toHaveLength(1);
	});

	it("cancels a cloud start when its own trigger asks to stop in flight", async () => {
		const { server, url } = startXaiDictation(ws => {
			ws.send(JSON.stringify({ type: "transcript.done", text: "never" }));
		});
		servers.push(server);
		settings.set("stt.provider", "xai");
		const capture = trackCapture();
		const gated = gatedXaiController(url, capture);
		controller = gated.controller;
		const editor = makeEditor();
		const options = makeOptions();

		const starting = gated.controller.toggle(editor, { ...options, trigger: "handsFree" });
		await gated.controller.toggle(editor, { ...options, trigger: "handsFree" });
		gated.release("k");
		await starting;

		// The stop the owner asked for wins: no microphone, no session, and the slot is spent so the
		// next latch records instead of stopping itself.
		expect(capture.rates).toHaveLength(0);
		expect(controller.state).toBe("idle");
		expect(controller.handsFreeActive).toBe(false);
	});

	it("drops ownership when the cloud start itself fails", async () => {
		settings.set("stt.provider", "xai");
		const capture = trackCapture();
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({
			cloud: () => ({
				modelRegistry: {
					...fakeXaiRegistry("http://127.0.0.1:1", undefined),
					getApiKeyForProvider: async () => {
						throw new Error("xAI credentials unavailable");
					},
				} as unknown as ModelRegistry,
				sessionId: "s",
			}),
			createCapture: capture.factory,
		});

		await controller.toggle(editor, { ...options, trigger: "handsFree" });

		expect(controller.state).toBe("idle");
		expect(controller.handsFreeActive).toBe(false);
		expect(options.showWarning).toHaveBeenCalledWith("xAI credentials unavailable");

		// The failed latch must not leave the hold trigger locked out of the next start.
		await controller.toggle(editor, { ...options, trigger: "hold" });
		expect(options.showWarning).toHaveBeenCalledTimes(2);
	});
});
