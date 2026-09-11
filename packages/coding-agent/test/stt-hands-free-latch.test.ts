import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as asrClient from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

/**
 * End-to-end latch contract: the real `CustomEditor` gestures driving the real `STTController`
 * (fake microphone, stubbed local stream). The unit suites cover each half on its own mocks; this
 * one pins the seam a user actually feels — a triple tap latches dictation, the push-to-talk
 * release does not cut it off, and the next latch toggle commits the transcript.
 */
describe("stt hands-free latch (editor + controller)", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		vi.useFakeTimers();
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.modelName", "fast");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("hello from hands free"),
			cancel: vi.fn(),
		});
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		vi.useRealTimers();
		restoreSettingsTestState(state);
		vi.restoreAllMocks();
	});

	it("latches from a triple tap and survives the hold release, then commits on the next toggle", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const stopped: string[] = [];
		controller = new STTController({ createCapture: () => ({ stop: () => stopped.push("stop") }) });
		const warn = vi.fn();
		const options = {
			showWarning: warn,
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
			requestRender: vi.fn(),
		};

		// Mirrors the input-controller wiring; the promises are captured so the test can await the
		// real work instead of guessing at a delay.
		let inFlight: Promise<void> | undefined;
		editor.sttHoldEnabled = () => true;
		editor.onSpaceHoldStart = () => {
			inFlight = controller?.toggle(editor, { ...options, trigger: "hold" });
		};
		editor.onSpaceHoldEnd = () => {
			inFlight = controller?.toggle(editor, { ...options, trigger: "hold" });
		};
		editor.onSpaceTapToggle = () => {
			inFlight = controller?.toggle(editor, { ...options, trigger: "handsFree" });
		};
		editor.handsFreeActive = () => controller?.handsFreeActive ?? false;

		editor.handleInput("draft ");
		// Human-paced taps: even gaps read as a held bar's repeat and deliberately do not latch.
		for (const gap of [150, 230, 170]) {
			vi.advanceTimersByTime(gap);
			editor.handleInput(" ");
		}
		await inFlight;

		expect(controller.state).toBe("recording");
		expect(controller.handsFreeActive).toBe(true);
		// The burst left no spaces behind.
		expect(editor.getText()).toBe("draft ");
		expect(warn).not.toHaveBeenCalled();

		// A hold release (push-to-talk stop) must not end a latched session.
		await controller.toggle(editor, { ...options, trigger: "hold" });
		expect(controller.state).toBe("recording");

		// The latch's own trigger ends it and the transcript lands in the composer.
		await controller.toggle(editor, { ...options, trigger: "handsFree" });
		expect(controller.state).toBe("idle");
		expect(controller.handsFreeActive).toBe(false);
		expect(editor.getText()).toBe("draft hello from hands free");
		expect(stopped).toEqual(["stop"]);
	});
});
