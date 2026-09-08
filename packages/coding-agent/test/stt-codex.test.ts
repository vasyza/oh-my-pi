import { afterEach, describe, expect, it } from "bun:test";
import type { OAuthAccess } from "@oh-my-pi/pi-ai";
import { createCodexSttStream, type CodexSttOptions } from "../src/stt/codex";

// Real time is intentional throughout: these exercise Bun WebSocket upgrade and
// message delivery against a loopback server, which fake timers do not drive
// through the socket stack (same precedent as mcp-http-transport.test.ts).

const ACCESS = { accessToken: "tok", accountId: "acc-1" } as OAuthAccess;

function stubStorage(access: OAuthAccess | undefined): CodexSttOptions["authStorage"] {
	return {
		getOAuthAccess: async () => access,
		rotateSessionCredential: async () => false,
	};
}

interface CodexWsScript {
	onStart?: (ws: Bun.ServerWebSocket<undefined>) => void;
	onAppend?: (ws: Bun.ServerWebSocket<undefined>, bytes: number) => void;
	onClose?: (ws: Bun.ServerWebSocket<undefined>) => void;
}

interface CodexSeen {
	protocols: string[];
	start: { sample_rate_hz: number; num_channels: number; input_audio_format: string } | null;
	appends: number[];
	closes: number;
}

function startDictationServer(script: CodexWsScript): {
	server: Bun.Server<undefined>;
	url: string;
	seen: CodexSeen;
} {
	const seen: CodexSeen = { protocols: [], start: null, appends: [], closes: 0 };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			if (new URL(req.url).pathname === "/dictation/stream") {
				seen.protocols =
					req.headers
						.get("sec-websocket-protocol")
						?.split(",")
						.map(part => part.trim()) ?? [];
				if (srv.upgrade(req)) return undefined as unknown as Response;
			}
			return new Response("nope", { status: 404 });
		},
		websocket: {
			message(ws, message) {
				if (typeof message !== "string") return;
				const parsed = JSON.parse(message) as { type?: string; config?: CodexSeen["start"]; audio?: string };
				if (parsed.type === "session.start" && parsed.config) {
					seen.start = {
						sample_rate_hz: parsed.config.sample_rate_hz,
						num_channels: parsed.config.num_channels,
						input_audio_format: parsed.config.input_audio_format,
					};
					script.onStart?.(ws);
					return;
				}
				if (parsed.type === "audio.append" && parsed.audio) {
					const bytes = Buffer.from(parsed.audio, "base64").byteLength;
					seen.appends.push(bytes);
					script.onAppend?.(ws, bytes);
					return;
				}
				if (parsed.type === "session.close") {
					seen.closes += 1;
					script.onClose?.(ws);
				}
			},
		},
	});
	return { server, url: `http://127.0.0.1:${server.port}`, seen };
}

function startedSession(id: string): string {
	return JSON.stringify({
		type: "session.started",
		sequence_no: 1,
		session: {
			session_id: id,
			status: "active",
			config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" },
		},
	});
}

function closedSession(sequence: number): string {
	return JSON.stringify({
		type: "session.updated",
		sequence_no: sequence,
		session: {
			session_id: "s",
			status: "closed",
			config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" },
		},
	});
}

describe("Codex STT streaming", () => {
	let server: Bun.Server<undefined> | null = null;

	afterEach(() => {
		server?.stop(true);
		server = null;
	});

	it("merges utterance revisions and closes exactly once", async () => {
		const partials: string[] = [];
		const setup = startDictationServer({
			onStart: ws => {
				ws.send(startedSession("s"));
				ws.send(
					JSON.stringify({
						type: "transcript.segment",
						sequence_no: 2,
						utterance_id: "a",
						revision: 2,
						text: "alpha v2",
					}),
				);
				ws.send(
					JSON.stringify({
						type: "transcript.segment",
						sequence_no: 3,
						utterance_id: "a",
						revision: 1,
						text: "alpha stale",
					}),
				);
				ws.send(
					JSON.stringify({
						type: "transcript.final",
						sequence_no: 4,
						utterance_id: "a",
						revision: 1,
						text: "Alpha.",
					}),
				);
				// Late segment after final must not roll the utterance back.
				ws.send(
					JSON.stringify({
						type: "transcript.segment",
						sequence_no: 5,
						utterance_id: "a",
						revision: 3,
						text: "alpha late",
					}),
				);
				ws.send(
					JSON.stringify({
						type: "transcript.final",
						sequence_no: 6,
						utterance_id: "b",
						revision: 1,
						text: "Beta.",
					}),
				);
			},
			onClose: ws => ws.send(closedSession(7)),
		});
		server = setup.server;

		const stream = createCodexSttStream({
			authStorage: stubStorage(ACCESS),
			sessionId: "sess",
			access: ACCESS,
			baseURL: setup.url,
			onPartial: text => partials.push(text),
		});
		// Four float samples pushed pre-ready still stream as one 8-byte append.
		stream.pushAudio(new Float32Array([0.5, -0.5, 0.1, -0.1]));
		await expect(stream.stop()).resolves.toBe("Alpha. Beta.");

		expect(setup.seen.start).toEqual({ sample_rate_hz: 24000, num_channels: 1, input_audio_format: "pcm16" });
		expect(setup.seen.appends).toEqual([8]);
		expect(setup.seen.closes).toBe(1);
		expect(setup.seen.protocols).toEqual(["chatgpt-dictation", "openai-bearer.tok", "codex-desktop"]);
		expect(partials).toEqual(["alpha v2", "Alpha.", "Alpha. Beta."]);
	});

	it("recovers mid-stream failure through one full-clip batch", async () => {
		const batches: { name: string; bytes: number; auth: string | null; account: string | null }[] = [];
		const deaths = { count: 0 };
		const batchServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req, srv) {
				const url = new URL(req.url);
				if (url.pathname === "/dictation/stream") {
					if (srv.upgrade(req)) return undefined as unknown as Response;
					return new Response("upgrade failed", { status: 500 });
				}
				if (url.pathname === "/transcribe" && req.method === "POST") {
					const file = (await req.formData()).get("file") as File;
					batches.push({
						name: file.name,
						bytes: file.size,
						auth: req.headers.get("authorization"),
						account: req.headers.get("chatgpt-account-id"),
					});
					return Response.json({ text: "batch fallback wins" });
				}
				return new Response("nope", { status: 404 });
			},
			websocket: {
				message(ws, message) {
					if (typeof message !== "string") return;
					const parsed = JSON.parse(message) as { type?: string };
					if (parsed.type === "session.start") {
						ws.send(startedSession("s2"));
						return;
					}
					if (parsed.type === "audio.append") {
						deaths.count += 1;
						ws.send(
							JSON.stringify({
								type: "transcript.segment",
								sequence_no: 2,
								utterance_id: "u",
								revision: 1,
								text: "streaming preview",
							}),
						);
						ws.close(1011, "boom");
					}
				},
			},
		});
		const previous = server;
		server = batchServer;
		try {
			const statuses: string[] = [];
			const errors: string[] = [];
			const partials: string[] = [];
			const stream = createCodexSttStream({
				authStorage: stubStorage(ACCESS),
				sessionId: "sess",
				access: ACCESS,
				baseURL: `http://127.0.0.1:${batchServer.port}`,
				onPartial: text => partials.push(text),
				onStatus: message => statuses.push(message),
				onError: error => errors.push(error.message),
			});
			stream.pushAudio(new Float32Array(480).fill(0.5));
			await Bun.sleep(300);
			// Audio after the failure keeps buffering for the same single batch.
			stream.pushAudio(new Float32Array(480).fill(0.5));
			await expect(stream.stop()).resolves.toBe("batch fallback wins");

			expect(deaths.count).toBe(1);
			expect(batches).toHaveLength(1);
			expect(batches[0]?.name).toBe("audio.wav");
			// Full clip: two 480-sample chunks plus the 44-byte WAV header.
			expect(batches[0]?.bytes).toBe(44 + 960 * 2);
			expect(batches[0]?.auth).toBe("Bearer tok");
			expect(batches[0]?.account).toBe("acc-1");
			expect(statuses).toEqual(["OpenAI streaming unavailable; transcription will finish after recording."]);
			expect(errors).toEqual([]);
			expect(partials.at(-1)).toBe("batch fallback wins");
		} finally {
			batchServer.stop(true);
			server = previous;
		}
	});

	it("returns the streaming error on silence instead of an empty batch", async () => {
		const batches: unknown[] = [];
		const combined = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req, srv) {
				const url = new URL(req.url);
				if (url.pathname === "/dictation/stream") {
					if (srv.upgrade(req)) return undefined as unknown as Response;
					return new Response("upgrade failed", { status: 500 });
				}
				if (url.pathname === "/transcribe") {
					batches.push(await req.formData());
					return Response.json({ text: "must not happen" });
				}
				return new Response("nope", { status: 404 });
			},
			websocket: {
				message(ws, message) {
					if (typeof message !== "string") return;
					const parsed = JSON.parse(message) as { type?: string };
					if (parsed.type === "session.start") {
						ws.send(startedSession("s"));
						return;
					}
					if (parsed.type === "audio.append") ws.close(1011, "boom");
				},
			},
		});
		server = combined;
		try {
			const stream = createCodexSttStream({
				authStorage: stubStorage(ACCESS),
				sessionId: "sess",
				access: ACCESS,
				baseURL: `http://127.0.0.1:${combined.port}`,
			});
			// Zero-energy audio: below the sounding threshold, so no batch.
			stream.pushAudio(new Float32Array(480));
			await Bun.sleep(300);
			await expect(stream.stop()).rejects.toThrow(/closed before completion/);
			expect(batches).toHaveLength(0);
		} finally {
			combined.stop(true);
			server = null;
		}
	});

	it("never sends batch on abort and resolves stop with empty", async () => {
		let batches = 0;
		const setup = startDictationServer({
			onStart: ws => ws.send(startedSession("s")),
			onAppend: ws => ws.close(1011, "boom"),
		});
		const abortable = new AbortController();
		const batchServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req, srv) {
				const url = new URL(req.url);
				if (url.pathname === "/dictation/stream") {
					if (srv.upgrade(req)) return undefined as unknown as Response;
					return new Response("upgrade failed", { status: 500 });
				}
				if (url.pathname === "/transcribe") {
					batches += 1;
					return Response.json({ text: "must not happen" });
				}
				return new Response("nope", { status: 404 });
			},
			websocket: {
				message(ws, message) {
					if (typeof message !== "string") return;
					const parsed = JSON.parse(message) as { type?: string };
					if (parsed.type === "session.start") {
						ws.send(startedSession("s"));
						return;
					}
					if (parsed.type === "audio.append") ws.close(1011, "boom");
				},
			},
		});
		setup.server.stop(true);
		server = batchServer;
		try {
			const stream = createCodexSttStream({
				authStorage: stubStorage(ACCESS),
				sessionId: "sess",
				access: ACCESS,
				baseURL: `http://127.0.0.1:${batchServer.port}`,
				signal: abortable.signal,
			});
			stream.pushAudio(new Float32Array(480).fill(0.5));
			await Bun.sleep(300);
			abortable.abort();
			await expect(stream.stop()).resolves.toBe("");
			expect(batches).toBe(0);
		} finally {
			batchServer.stop(true);
			server = null;
		}
	});

	it("refreshes OAuth on 401 and rejects terminal batch failures without switching provider", async () => {
		const seenAuth: (string | null)[] = [];
		const seenAccount: (string | null)[] = [];
		let calls = 0;
		const batchServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req, srv) {
				const url = new URL(req.url);
				if (url.pathname === "/dictation/stream") {
					if (srv.upgrade(req)) return undefined as unknown as Response;
					return new Response("upgrade failed", { status: 500 });
				}
				if (url.pathname === "/transcribe" && req.method === "POST") {
					calls += 1;
					seenAuth.push(req.headers.get("authorization"));
					seenAccount.push(req.headers.get("chatgpt-account-id"));
					if (calls === 1) return new Response("expired", { status: 401 });
					return Response.json({ text: "refreshed batch" });
				}
				return new Response("nope", { status: 404 });
			},
			websocket: {
				message(ws, message) {
					if (typeof message !== "string") return;
					const parsed = JSON.parse(message) as { type?: string };
					if (parsed.type === "session.start") {
						ws.send(startedSession("s"));
						return;
					}
					if (parsed.type === "audio.append") ws.close(1011, "boom");
				},
			},
		});
		const previous = server;
		server = batchServer;
		try {
			const refreshed = { accessToken: "tok-2", accountId: "acc-2" } as OAuthAccess;
			let forceRefreshSeen = false;
			const stream = createCodexSttStream({
				authStorage: {
					getOAuthAccess: async (_provider, _session, opts) => {
						if (opts?.forceRefresh) {
							forceRefreshSeen = true;
							return refreshed;
						}
						return ACCESS;
					},
					rotateSessionCredential: async () => false,
				},
				sessionId: "sess",
				access: ACCESS,
				baseURL: `http://127.0.0.1:${batchServer.port}`,
			});
			stream.pushAudio(new Float32Array(480).fill(0.5));
			await Bun.sleep(300);
			await expect(stream.stop()).resolves.toBe("refreshed batch");
			expect(forceRefreshSeen).toBe(true);
			expect(seenAuth).toEqual(["Bearer tok", "Bearer tok-2"]);
			expect(seenAccount).toEqual(["acc-1", "acc-2"]);
			expect(calls).toBe(2);
		} finally {
			batchServer.stop(true);
			server = previous;
		}
	});

	it("rejects malformed batch payloads and persistent 403s", async () => {
		async function expectBatchError(
			reply: (req: Request) => Response | Promise<Response>,
			pattern: RegExp,
		): Promise<void> {
			const batchServer = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(req, srv) {
					const url = new URL(req.url);
					if (url.pathname === "/dictation/stream") {
						if (srv.upgrade(req)) return undefined as unknown as Response;
						return new Response("upgrade failed", { status: 500 });
					}
					if (url.pathname === "/transcribe") return reply(req);
					return new Response("nope", { status: 404 });
				},
				websocket: {
					message(ws, message) {
						if (typeof message !== "string") return;
						const parsed = JSON.parse(message) as { type?: string };
						if (parsed.type === "session.start") {
							ws.send(startedSession("s"));
							return;
						}
						if (parsed.type === "audio.append") ws.close(1011, "boom");
					},
				},
			});
			const previous = server;
			server = batchServer;
			try {
				const stream = createCodexSttStream({
					authStorage: stubStorage(ACCESS),
					sessionId: "sess",
					access: ACCESS,
					baseURL: `http://127.0.0.1:${batchServer.port}`,
				});
				stream.pushAudio(new Float32Array(480).fill(0.5));
				await Bun.sleep(300);
				await expect(stream.stop()).rejects.toThrow(pattern);
			} finally {
				batchServer.stop(true);
				server = previous;
			}
		}

		await expectBatchError(() => Response.json({ nope: 1 }), /invalid response/);
		await expectBatchError(() => new Response("denied", { status: 403 }), /403/);
	});

	it("recovers segment-only close through batch instead of dropping words", async () => {
		const batchServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req, srv) {
				const url = new URL(req.url);
				if (url.pathname === "/dictation/stream") {
					if (srv.upgrade(req)) return undefined as unknown as Response;
					return new Response("upgrade failed", { status: 500 });
				}
				if (url.pathname === "/transcribe") return Response.json({ text: "whole clip" });
				return new Response("nope", { status: 404 });
			},
			websocket: {
				message(ws, message) {
					if (typeof message !== "string") return;
					const parsed = JSON.parse(message) as { type?: string };
					if (parsed.type === "session.start") {
						ws.send(startedSession("s"));
						ws.send(
							JSON.stringify({
								type: "transcript.segment",
								sequence_no: 2,
								utterance_id: "u",
								revision: 1,
								text: "provisional",
							}),
						);
						return;
					}
					if (parsed.type === "session.close") ws.send(closedSession(3));
				},
			},
		});
		const previous = server;
		server = batchServer;
		try {
			const stream = createCodexSttStream({
				authStorage: stubStorage(ACCESS),
				sessionId: "sess",
				access: ACCESS,
				baseURL: `http://127.0.0.1:${batchServer.port}`,
			});
			stream.pushAudio(new Float32Array(480).fill(0.5));
			await Bun.sleep(150);
			await expect(stream.stop()).resolves.toBe("whole clip");
		} finally {
			batchServer.stop(true);
			server = previous;
		}
	});

	it("rejects past the five-minute clip cap with the exact limit message", async () => {
		const setup = startDictationServer({ onStart: ws => ws.send(startedSession("s")) });
		server = setup.server;

		const errors: string[] = [];
		const stream = createCodexSttStream({
			authStorage: stubStorage(ACCESS),
			sessionId: "sess",
			access: ACCESS,
			baseURL: setup.url,
			onError: error => errors.push(error.message),
		});
		// 14_400_000 PCM bytes cap: 73 chunks of 100k samples (200kB each).
		for (let i = 0; i < 73; i += 1) {
			stream.pushAudio(new Float32Array(100_000).fill(0.1));
		}
		await expect(stream.stop()).rejects.toThrow("Cloud dictation reached the 5-minute recording limit.");
		expect(errors).toEqual(["Cloud dictation reached the 5-minute recording limit."]);
	});
});
