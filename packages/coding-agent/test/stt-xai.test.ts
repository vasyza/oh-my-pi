import { afterEach, describe, expect, it } from "bun:test";
import { createXaiSttStream } from "../src/stt/xai";

// Real time is intentional throughout: these exercise Bun WebSocket upgrade and
// message delivery against a loopback server, which fake timers do not drive
// through the socket stack (same precedent as mcp-http-transport.test.ts).

function decodePcm16(bytes: Uint8Array): number[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: number[] = [];
	for (let i = 0; i < bytes.byteLength; i += 2) out.push(view.getInt16(i, true));
	return out;
}

interface XaiScript {
	onOpen?: (ws: Bun.ServerWebSocket<{ auth: string | null }>) => void;
	onMessage?: (ws: Bun.ServerWebSocket<{ auth: string | null }>, message: string | Uint8Array) => void;
}

function startXaiServer(script: XaiScript): {
	server: Bun.Server<{ auth: string | null }>;
	url: string;
	seen: { auth: string | null; query: string; binary: Uint8Array[]; done: number };
} {
	const seen = { auth: null as string | null, query: "", binary: [] as Uint8Array[], done: 0 };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/stt") {
				seen.query = url.search;
				if (srv.upgrade(req, { data: { auth: req.headers.get("authorization") } })) {
					return undefined as unknown as Response;
				}
			}
			return new Response("nope", { status: 404 });
		},
		websocket: {
			data: {} as { auth: string | null },
			open(ws) {
				seen.auth = ws.data.auth;
				script.onOpen?.(ws);
			},
			message(ws, message) {
				if (typeof message !== "string") {
					seen.binary.push(new Uint8Array(message));
					script.onMessage?.(ws, new Uint8Array(message));
					return;
				}
				if ((JSON.parse(message) as { type?: string }).type === "audio.done") seen.done += 1;
				script.onMessage?.(ws, message);
			},
		},
	});
	return { server, url: `http://127.0.0.1:${server.port}`, seen };
}

describe("xAI STT streaming", () => {
	let server: Bun.Server<{ auth: string | null }> | null = null;

	afterEach(() => {
		server?.stop(true);
		server = null;
	});

	it("buffers audio until created, then streams exact PCM16 LE bytes", async () => {
		let binaryBeforeCreated = -1;
		const setup = startXaiServer({
			onOpen: ws => {
				setTimeout(() => {
					binaryBeforeCreated = setup.seen.binary.length;
					ws.send(JSON.stringify({ type: "transcript.created" }));
				}, 80);
			},
		});
		server = setup.server;

		const stream = createXaiSttStream({ provider: "xai", apiKey: "k", baseURL: setup.url, language: "en" });
		stream.pushAudio(new Float32Array([-2, -0.5, 0, 0.5, 2]));
		await Bun.sleep(200);

		expect(binaryBeforeCreated).toBe(0);
		expect(setup.seen.binary).toHaveLength(1);
		expect(decodePcm16(setup.seen.binary[0]!)).toEqual([-32_768, -16_384, 0, 16_384, 32_767]);
		expect(setup.seen.query).toContain("sample_rate=16000");
		expect(setup.seen.query).toContain("encoding=pcm");
		expect(setup.seen.query).toContain("interim_results=true");
		expect(setup.seen.query).toContain("language=en");
		stream.cancel();
	});

	it("assembles interim, chunk-final, speech-final, and trailing done without repeats", async () => {
		const partials: string[] = [];
		const setup = startXaiServer({
			onOpen: ws => ws.send(JSON.stringify({ type: "transcript.created" })),
			onMessage: (ws, message) => {
				if (typeof message === "string") return;
				ws.send(
					JSON.stringify({ type: "transcript.partial", text: "hello", is_final: false, speech_final: false }),
				);
				ws.send(JSON.stringify({ type: "transcript.partial", text: "hello", is_final: true, speech_final: false }));
				ws.send(
					JSON.stringify({ type: "transcript.partial", text: "world", is_final: false, speech_final: false }),
				);
			},
		});
		server = setup.server;

		const stream = createXaiSttStream({
			provider: "xai",
			apiKey: "k",
			baseURL: setup.url,
			onPartial: text => partials.push(text),
		});
		stream.pushAudio(new Float32Array([0.1, 0.2]));
		await Bun.sleep(150);
		// Chunk-final locks "hello"; interim "world" previews against the lock;
		// neither repeats the locked chunk.
		expect(partials).toEqual(["hello", "hello world"]);
		stream.cancel();
	});

	it("sends one audio.done and resolves speech-final plus trailing done", async () => {
		const setup = startXaiServer({
			onOpen: ws => ws.send(JSON.stringify({ type: "transcript.created" })),
			onMessage: (ws, message) => {
				if (typeof message !== "string" || JSON.parse(message).type !== "audio.done") return;
				ws.send(
					JSON.stringify({ type: "transcript.partial", text: "Hello world.", is_final: true, speech_final: true }),
				);
				ws.send(JSON.stringify({ type: "transcript.done", text: "Next sentence." }));
			},
		});
		server = setup.server;

		const stream = createXaiSttStream({ provider: "xai", apiKey: "k", baseURL: setup.url });
		stream.pushAudio(new Float32Array([0.1]));
		await expect(stream.stop()).resolves.toBe("Hello world. Next sentence.");
		expect(setup.seen.done).toBe(1);
		expect(setup.seen.auth).toBe("Bearer k");
		// Repeated stop resolves the same result without a second audio.done.
		await expect(stream.stop()).resolves.toBe("Hello world. Next sentence.");
		expect(setup.seen.done).toBe(1);
	});

	it("rejects once on server errors, binary frames, malformed events, and early close", async () => {
		async function expectStopError(
			script: (ws: Bun.ServerWebSocket<{ auth: string | null }>) => void,
			pattern: RegExp,
		): Promise<void> {
			const errors: string[] = [];
			const setup = startXaiServer({
				onOpen: ws => {
					ws.send(JSON.stringify({ type: "transcript.created" }));
					script(ws);
				},
			});
			const previous = server;
			server = setup.server;
			try {
				const stream = createXaiSttStream({
					provider: "xai",
					apiKey: "k",
					baseURL: setup.url,
					onError: error => errors.push(error.message),
				});
				stream.pushAudio(new Float32Array([0.1]));
				await expect(stream.stop()).rejects.toThrow(pattern);
				expect(errors).toHaveLength(1);
				expect(errors[0]).toMatch(pattern);
			} finally {
				setup.server.stop(true);
				server = previous;
			}
		}

		await expectStopError(ws => {
			ws.send(JSON.stringify({ type: "error", message: "quota exhausted" }));
		}, /quota exhausted/);
		await expectStopError(ws => {
			ws.send(new Uint8Array([1, 2, 3]));
		}, /unexpected binary frame/);
		await expectStopError(ws => {
			ws.send("not json{{{");
		}, /invalid event payload/);
		await expectStopError(ws => {
			ws.close(1011, "gone");
		}, /closed before completion/);
	});

	it("waits for created when stop races readiness", async () => {
		const setup = startXaiServer({
			onOpen: ws => {
				setTimeout(() => ws.send(JSON.stringify({ type: "transcript.created" })), 120);
			},
			onMessage: (ws, message) => {
				if (typeof message === "string" && JSON.parse(message).type === "audio.done") {
					ws.send(JSON.stringify({ type: "transcript.done", text: "late hello" }));
				}
			},
		});
		server = setup.server;

		const stream = createXaiSttStream({ provider: "xai", apiKey: "k", baseURL: setup.url });
		stream.pushAudio(new Float32Array([0.3]));
		await expect(stream.stop()).resolves.toBe("late hello");
		expect(setup.seen.done).toBe(1);
	});

	it("cancel resolves stop with empty and ignores later audio", async () => {
		const setup = startXaiServer({
			onOpen: ws => ws.send(JSON.stringify({ type: "transcript.created" })),
		});
		server = setup.server;

		const stream = createXaiSttStream({ provider: "xai", apiKey: "k", baseURL: setup.url });
		stream.pushAudio(new Float32Array([0.3]));
		stream.cancel();
		stream.pushAudio(new Float32Array([0.4]));
		await expect(stream.stop()).resolves.toBe("");
	});
});
