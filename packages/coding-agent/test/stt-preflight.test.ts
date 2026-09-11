import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as asrClient from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { getTinyModelsCacheDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const WHISPER_BASE_REPO = "onnx-community/whisper-base";
const PARAKEET_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";

async function touch(file: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "x");
}

describe("isSttModelCached completeness", () => {
	let state: SettingsTestState | undefined;
	let tmp = "";
	let cacheDir = "";

	beforeEach(async () => {
		state = beginSettingsTest();
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stt-cache-"));
		setAgentDir(tmp);
		cacheDir = getTinyModelsCacheDir();
	});

	afterEach(async () => {
		restoreSettingsTestState(state);
		await removeWithRetries(tmp);
	});

	it("treats a transformers model as cached only when both encoder and decoder onnx are present", async () => {
		const repoDir = path.join(cacheDir, WHISPER_BASE_REPO);
		await touch(path.join(repoDir, "config.json"));
		await touch(path.join(repoDir, "onnx", "encoder_model.onnx"));
		// Only the encoder shard landed — an interrupted Whisper download.
		expect(await downloader.isSttModelCached("fast")).toBe(false);

		await touch(path.join(repoDir, "onnx", "decoder_model_merged.onnx"));
		expect(await downloader.isSttModelCached("fast")).toBe(true);
	});

	it("treats a transformers model with config.json but no onnx weights as not cached", async () => {
		await touch(path.join(cacheDir, WHISPER_BASE_REPO, "config.json"));
		expect(await downloader.isSttModelCached("fast")).toBe(false);
	});

	it("requires every sherpa model file to be present", async () => {
		const repoDir = path.join(cacheDir, PARAKEET_REPO);
		await touch(path.join(repoDir, "encoder.int8.onnx"));
		await touch(path.join(repoDir, "decoder.int8.onnx"));
		await touch(path.join(repoDir, "joiner.int8.onnx"));
		// tokens.txt still missing.
		expect(await downloader.isSttModelCached("parakeet")).toBe(false);

		await touch(path.join(repoDir, "tokens.txt"));
		expect(await downloader.isSttModelCached("parakeet")).toBe(true);
	});
});

describe("STTController preflight", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;

	function makeEditor() {
		return {
			insertText: vi.fn(),
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			getText: vi.fn().mockReturnValue(""),
			setText: vi.fn(),
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

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.modelName", "fast");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue(""),
			cancel: vi.fn(),
		});
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		restoreSettingsTestState(state);
		vi.restoreAllMocks();
	});

	it("cached model: starts recording without awaiting the model load, warming it in the background", async () => {
		const isCached = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		// A warmup that never resolves would hang #ensureDeps if it were awaited;
		// reaching "recording" proves the fast path does not block on it.
		const download = vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));

		const editor = makeEditor();
		controller = new STTController({ createCapture: () => ({ stop: vi.fn() }) });
		const options = makeOptions();
		await controller.toggle(editor, options);

		expect(controller.state).toBe("recording");
		expect(isCached).toHaveBeenCalledWith("fast");
		// Background warm calls downloadSttModel with no progress callback.
		expect(download).toHaveBeenCalledTimes(1);
		expect(download.mock.calls[0]).toHaveLength(1);
		// Nothing was written to the status line, so it must not be cleared.
		expect(options.showStatus).not.toHaveBeenCalled();
	});

	it("uncached model: downloads in the foreground with progress before recording", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		const download = vi.spyOn(downloader, "downloadSttModel").mockImplementation((_key, onProgress) => {
			onProgress?.({
				status: "progress",
				percent: 42,
				loaded: 1,
				total: 2,
				repo: WHISPER_BASE_REPO,
				label: "Whisper base",
			});
			return Promise.resolve();
		});

		const editor = makeEditor();
		controller = new STTController({ createCapture: () => ({ stop: vi.fn() }) });
		const options = makeOptions();
		await controller.toggle(editor, options);

		expect(controller.state).toBe("recording");
		// Foreground path passes a progress callback (2 args) and surfaces it.
		expect(download.mock.calls[0]).toHaveLength(2);
		expect(options.showStatus).toHaveBeenCalledWith("Downloading speech model Whisper base (42%)");
		// Status was written, so the line is cleared at the end.
		expect(options.showStatus).toHaveBeenLastCalledWith("");
	});

	it("re-runs preflight when the model changes mid-session", async () => {
		const isCached = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));

		const editor = makeEditor();
		controller = new STTController({ createCapture: () => ({ stop: vi.fn() }) });
		await controller.toggle(editor, makeOptions());
		expect(controller.state).toBe("recording");
		expect(isCached).toHaveBeenLastCalledWith("fast");

		// Switch the model, then stop and re-start the gesture.
		settings.set("stt.modelName", "turbo");
		await controller.toggle(editor, makeOptions()); // recording -> idle
		expect(controller.state).toBe("idle");
		await controller.toggle(editor, makeOptions()); // idle -> recording

		expect(controller.state).toBe("recording");
		// Preflight ran again for the new tier rather than short-circuiting.
		expect(isCached).toHaveBeenLastCalledWith("turbo");
	});
	it("stops recording and surfaces asynchronous microphone failures", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const stopCapture = vi.fn();
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({
			createCapture: (_sampleRate, callback) => {
				onAudio = callback;
				return { stop: stopCapture };
			},
		});
		await controller.toggle(editor, options);

		onAudio?.(new Error("Microphone permission denied"), new Float32Array());

		expect(controller.state).toBe("idle");
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(editor.clearVolatileText).toHaveBeenCalledTimes(1);
		expect(options.showWarning).toHaveBeenCalledWith("Microphone permission denied");
	});

	it("keeps a latched recording alive when the push-to-talk gesture releases", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({ createCapture: () => ({ stop: vi.fn() }) });

		await controller.toggle(editor, { ...options, trigger: "handsFree" });
		expect(controller.state).toBe("recording");
		expect(controller.handsFreeActive).toBe(true);

		// The space bar's release — the push-to-talk stop — must not cut off the dictation the user
		// is still speaking into with the terminal unfocused.
		await controller.toggle(editor, { ...options, trigger: "hold" });
		expect(controller.state).toBe("recording");
		expect(controller.handsFreeActive).toBe(true);

		// The latch's own trigger ends it.
		await controller.toggle(editor, { ...options, trigger: "handsFree" });
		expect(controller.state).toBe("idle");
		expect(controller.handsFreeActive).toBe(false);
	});

	it("does not let the latch take over an active push-to-talk recording", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({ createCapture: () => ({ stop: vi.fn() }) });

		await controller.toggle(editor, { ...options, trigger: "hold" });
		expect(controller.state).toBe("recording");
		expect(controller.handsFreeActive).toBe(false);

		// A latch press while the bar is still held leaves the hold session alone...
		await controller.toggle(editor, { ...options, trigger: "handsFree" });
		expect(controller.state).toBe("recording");
		expect(controller.handsFreeActive).toBe(false);

		// ...and the hold's own release still ends it.
		await controller.toggle(editor, { ...options, trigger: "hold" });
		expect(controller.state).toBe("idle");
	});

	it("keeps the latch alive when the hold trigger fires during its start", async () => {
		const preflight = Promise.withResolvers<boolean>();
		vi.spyOn(downloader, "isSttModelCached").mockReturnValue(preflight.promise);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({ createCapture: () => ({ stop: vi.fn() }) });

		// The latch's start is in flight (first-run preflight) when the bar's release arrives: it must
		// not cancel the session the user just asked for.
		const starting = controller.toggle(editor, { ...options, trigger: "handsFree" });
		await controller.toggle(editor, { ...options, trigger: "hold" });
		preflight.resolve(true);
		await starting;

		expect(controller.state).toBe("recording");
		expect(controller.handsFreeActive).toBe(true);
	});

	it("honours the owner's release when the other trigger presses mid-start", async () => {
		const preflight = Promise.withResolvers<boolean>();
		vi.spyOn(downloader, "isSttModelCached").mockReturnValue(preflight.promise);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({ createCapture: () => ({ stop: vi.fn() }) });

		// The bar goes down (start in flight), comes up (the release), and only then does the latch
		// key arrive: the release belongs to the session being started and must still end it.
		const starting = controller.toggle(editor, { ...options, trigger: "hold" });
		await controller.toggle(editor, { ...options, trigger: "hold" });
		await controller.toggle(editor, { ...options, trigger: "handsFree" });
		preflight.resolve(true);
		await starting;

		expect(controller.state).toBe("idle");
		expect(controller.handsFreeActive).toBe(false);
	});

	it("does not leak a mid-start stop into the next session", async () => {
		const preflight = Promise.withResolvers<boolean>();
		vi.spyOn(downloader, "isSttModelCached").mockReturnValue(preflight.promise);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController({
			createCapture: (_sampleRate, callback) => {
				onAudio = callback;
				return { stop: vi.fn() };
			},
		});

		// A hold start in flight, then the latch key: that stop request belongs to the hold session
		// that never started, so it must not be kept for the next latch.
		const starting = controller.toggle(editor, { ...options, trigger: "hold" });
		await controller.toggle(editor, { ...options, trigger: "handsFree" });
		preflight.resolve(true);
		await starting;
		expect(controller.state).toBe("recording");

		// The microphone dies mid-session, ending it without going through toggle().
		onAudio?.(new Error("Microphone permission denied"), new Float32Array());
		expect(controller.state).toBe("idle");

		// A latch started now must record instead of stopping itself the moment it starts.
		await controller.toggle(editor, { ...options, trigger: "handsFree" });
		expect(controller.state).toBe("recording");
		expect(controller.handsFreeActive).toBe(true);
	});

	it("drops latch ownership when its start fails so push-to-talk still works", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		const editor = makeEditor();
		const options = makeOptions();
		let microphoneAvailable = false;
		controller = new STTController({
			createCapture: () => {
				if (!microphoneAvailable) throw new Error("No microphone");
				return { stop: vi.fn() };
			},
		});

		await controller.toggle(editor, { ...options, trigger: "handsFree" });
		expect(controller.state).toBe("idle");
		expect(controller.handsFreeActive).toBe(false);
		expect(options.showWarning).toHaveBeenCalledWith("No microphone");

		// The failed latch must not lock the hold trigger out of the microphone.
		microphoneAvailable = true;
		await controller.toggle(editor, { ...options, trigger: "hold" });
		expect(controller.state).toBe("recording");
		expect(controller.handsFreeActive).toBe(false);
	});
});
