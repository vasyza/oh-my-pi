import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { $ } from "bun";
import { getDefaultPasteImageKeys } from "../../../src/config/keybindings";
import { chipLabel } from "../../../src/modes/composer-attachments";
import {
	CustomEditor,
	extractBracketedImagePastePaths,
	extractBracketedPastePaths,
	extractImagePastePathsFromText,
	extractImagePathFromText,
	extractPastePathsFromText,
	SPACE_HOLD_MECHANICAL_RUN,
	SPACE_HOLD_RELEASE_MS,
	SPACE_REPEAT_MAX_GAP_MS,
	SPACE_TAP_COUNT,
	SPACE_TAP_GAP_MS,
} from "../../../src/modes/components/custom-editor";
import { getEditorTheme, initTheme, theme } from "../../../src/modes/theme/theme";

function makeEditor() {
	const editor = new CustomEditor(getEditorTheme());
	const events: string[] = [];
	editor.sttHoldEnabled = () => true;
	editor.onSpaceHoldStart = () => events.push("start");
	editor.onSpaceHoldEnd = () => events.push("end");
	return { editor, events };
}

/** A gap below SPACE_REPEAT_MAX_GAP_MS — looks like OS key auto-repeat (a held bar). */
const REPEAT_GAP_MS = 30;
/** A gap above the threshold — looks like a deliberate keypress. */
const TAP_GAP_MS = SPACE_REPEAT_MAX_GAP_MS + 80;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function bracketedPaste(text: string): string {
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/** Feed `count` spaces `gapMs` apart on the fake clock. The first space of a run has no prior
 *  space, so its gap is effectively infinite and it always reads as a deliberate tap. */
function feedSpaces(editor: CustomEditor, count: number, gapMs: number): void {
	for (let i = 0; i < count; i++) {
		vi.advanceTimersByTime(gapMs);
		editor.handleInput(" ");
	}
}

/** Feed spaces at explicit per-press gaps (ms) on the fake clock — for simulating an irregular cadence. */
function feedGaps(editor: CustomEditor, gaps: number[]): void {
	for (const gapMs of gaps) {
		vi.advanceTimersByTime(gapMs);
		editor.handleInput(" ");
	}
}

/** Feed `count` deliberate taps with human jitter. Perfectly even gaps are *not* a tap gesture:
 *  OS key-repeat stays metronomic at any rate, so the latch refuses them (`SPACE_TAP_METRONOME_MS`). */
function feedTaps(editor: CustomEditor, count: number): void {
	const gaps: number[] = [];
	for (let i = 0; i < count; i++) gaps.push(i % 2 === 0 ? TAP_GAP_MS : TAP_GAP_MS + 60);
	feedGaps(editor, gaps);
}

async function decorateInFreshProcess(text: string, imageLinks?: readonly string[]): Promise<string> {
	const customEditorUrl = new URL("../../../src/modes/components/custom-editor.ts", import.meta.url).href;
	const script = `
import { CustomEditor } from ${JSON.stringify(customEditorUrl)};
const editor = new CustomEditor({});
editor.imageLinks = ${JSON.stringify(imageLinks)};
process.stdout.write(editor.decorateText(${JSON.stringify(text)}));
`;
	const child = await $`bun -e ${script}`.quiet().nothrow();
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (child.exitCode !== 0) throw new Error(stderr || stdout || `decorate subprocess exited with ${child.exitCode}`);
	return stdout;
}

describe("CustomEditor placeholder decoration", () => {
	it("renders paste placeholders before theme initialization", async () => {
		const output = await decorateInFreshProcess("[Paste #1, +30 lines]");
		expect(output).toBe("[Paste #1, +30 lines]");
	});

	it("renders linked image placeholders before theme and settings initialization", async () => {
		const output = await decorateInFreshProcess("[Image #1]", ["/tmp/example.png"]);
		expect(output).toBe("[Image #1]");
	});
});

describe("CustomEditor restored image drafts", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("submits restored images with their historical prompt", () => {
		const editor = new CustomEditor(getEditorTheme());
		const image: ImageContent = {
			type: "image",
			data: "aW1hZ2U=",
			mimeType: "image/png",
		};
		let submitted: { text: string; images: ImageContent[] } | undefined;
		editor.onSubmit = text => {
			submitted = { text, images: [...editor.pendingImages] };
		};

		editor.setDraft("Inspect [Image #1, 1x1]", [image]);
		editor.submit();

		expect(submitted).toEqual({
			text: "Inspect [Image #1, 1x1]",
			images: [image],
		});
	});
});

describe("CustomEditor queue shorthand decoration", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("reserves the first line as soon as either queue prefix is completed", () => {
		for (const prefix of ["->", "=>"]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.handleInput(prefix[0] ?? "");
			expect(editor.getText()).toBe(prefix[0]);

			editor.handleInput(prefix[1] ?? "");
			expect(editor.getText()).toBe(`${prefix}\n`);
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			editor.handleInput("\x7f");
			expect(editor.getText()).toBe(`${prefix}\n`);
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
		}
	});

	it("renders the reserved line as a dim Queueing header", () => {
		for (const prefix of ["->", "=>"]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.setText(`${prefix}\nqueue this`);

			expect(editor.decorateText(prefix, { line: 0, startCol: 0, endCol: prefix.length })).toBe(
				theme.fg("dim", `Queueing ${theme.nav.selected}`),
			);
			editor.focused = true;
			const rendered = editor.render(40).map(line => Bun.stripANSI(line.replace(CURSOR_MARKER, "")));
			expect(rendered.some(line => line.includes(`Queueing ${theme.nav.selected}`))).toBe(true);
			expect(rendered.every(line => Bun.stringWidth(line) === 40)).toBe(true);
			expect(rendered.some(line => line.includes("queue this"))).toBe(true);
		}
	});

	it("highlights dot and parenthesis markers only for detected queue lists", () => {
		for (const [input, marker] of [
			["=>\n1. first\n2. second", "1."],
			["=>\n1) first\n2) second", "1)"],
		]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.setText(input);
			const text = `${marker} first`;
			expect(
				editor
					.decorateText(text, { line: 1, startCol: 0, endCol: text.length })
					.startsWith(theme.fg("accent", marker)),
			).toBe(true);
		}

		const unfinished = new CustomEditor(getEditorTheme());
		unfinished.setText("=>\n1. first\n2. second\n3. third\n4.");
		expect(
			unfinished.decorateText("1. first", { line: 1, startCol: 0, endCol: 8 }).startsWith(theme.fg("accent", "1.")),
		).toBe(true);
		expect(
			unfinished.decorateText("4.", { line: 4, startCol: 0, endCol: 2 }).startsWith(theme.fg("accent", "4.")),
		).toBe(true);

		const editor = new CustomEditor(getEditorTheme());
		editor.setText("=>\n1. first\n3. third");
		expect(editor.decorateText("1. first", { line: 1, startCol: 0, endCol: 8 })).toBe("1. first");
	});
});

describe("CustomEditor bracketed path paste", () => {
	it("leaves a pasted bare .png filename on the normal text path", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("icon-photo-default.png"))).toBeUndefined();
	});

	it("inserts a relative .png API address as text instead of treating it as a local image", () => {
		const { editor } = makeEditor();
		const address = "api/file/icon/867d45144217eec6d3c5805fd5a2d548.png";
		const onPasteImagePath = vi.fn();
		editor.onPasteImagePath = onPasteImagePath;

		editor.handleInput(bracketedPaste(address));

		expect(editor.getText()).toBe(address);
		expect(onPasteImagePath).not.toHaveBeenCalled();
		expect(extractImagePathFromText(address)).toBeUndefined();
	});

	it("extracts explicit local image paths for attachment", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("/tmp/icon-photo-default.png"))).toEqual([
			"/tmp/icon-photo-default.png",
		]);
		expect(extractBracketedImagePastePaths(bracketedPaste("C:\\Users\\me\\icon-photo-default.png"))).toEqual([
			"C:\\Users\\me\\icon-photo-default.png",
		]);
		expect(extractBracketedImagePastePaths(bracketedPaste("./images/icon-photo-default.png"))).toEqual([
			"./images/icon-photo-default.png",
		]);
	});

	it("routes a pasted video path through the attachment callback", () => {
		const { editor } = makeEditor();
		const video = "/Users/me/Movies/launch cut.mp4";
		const pasted: string[] = [];
		editor.onPasteImagePath = path => {
			pasted.push(path);
		};

		editor.handleInput(bracketedPaste(video));

		expect(extractBracketedImagePastePaths(bracketedPaste(video))).toEqual([video]);
		expect(pasted).toEqual([video]);
		expect(editor.getText()).toBe("");
	});

	it("keeps video previews distinct from image chips", () => {
		const { editor } = makeEditor();
		editor.pendingImages = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
		editor.pendingImageLinks = ["/tmp/launch.mp4"];
		editor.setCollapsedText("[Video #1, 960x480]");

		expect(editor.getText()).toBe(chipLabel("video", 1));
		expect(editor.composerChips()).toMatchObject([{ kind: "video", n: 1 }]);
	});

	it("strips `file://` URLs to the local filesystem path before loading the image", () => {
		// macOS / Ghostty / iTerm2 sometimes forward the pasteboard's
		// `public.file-url` representation when the user does Finder→Copy
		// then Cmd+V. Without decoding, `loadImageInput` would try to read a
		// literal `file:///…` path and fail.
		expect(extractBracketedImagePastePaths(bracketedPaste("file:///Users/me/Pictures/photo.png"))).toEqual([
			"/Users/me/Pictures/photo.png",
		]);
	});

	it("percent-decodes spaces inside `file://` URLs", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("file:///Users/me/My%20Pictures/photo.png"))).toEqual([
			"/Users/me/My Pictures/photo.png",
		]);
	});

	it("extracts explicit non-image paths without classifying them as image paths", () => {
		expect(extractBracketedPastePaths(bracketedPaste("/tmp/report.csv"))).toEqual(["/tmp/report.csv"]);
		expect(extractBracketedImagePastePaths(bracketedPaste("/tmp/report.csv"))).toBeUndefined();
	});

	it("inserts non-image path pastes as literal text instead of attaching them", () => {
		const { editor } = makeEditor();
		let imagePathCalls = 0;
		editor.onPasteImagePath = () => {
			imagePathCalls++;
		};

		editor.handleInput(bracketedPaste("/tmp/report.csv"));

		expect(editor.getText()).toBe("/tmp/report.csv");
		expect(imagePathCalls).toBe(0);
	});

	it("attaches a spaced screenshot path as an image instead of inserting it as literal text", () => {
		// #6578: the raw macOS "copy screenshot path" payload has unescaped
		// spaces, which defeats the segment splitter. Before the whole-text
		// fallback the paste degraded to literal text in the prompt.
		const { editor } = makeEditor();
		const screenshot = "/Users/me/Desktop/Screenshot 2026-07-24 at 1.55.12 PM.png";
		const pasted: string[] = [];
		editor.onPasteImagePath = path => {
			pasted.push(path);
		};

		editor.handleInput(bracketedPaste(screenshot));

		expect(pasted).toEqual([screenshot]);
		expect(editor.getText()).toBe("");
	});

	it("keeps a two-file drag with unescaped spaces as text instead of attaching one fused path", () => {
		// PR #6582 review: selecting two screenshots and dropping them together
		// emits a single space-separated payload the splitter also refuses
		// (`PM.png` carries no directory). Fusing it into one path attaches
		// nothing — `handleImagePathPaste` hits ENOENT and only shows a status,
		// never restoring the text — so the drop must degrade to a text paste.
		const { editor } = makeEditor();
		const dropped =
			"/Users/me/Desktop/Screenshot 2026-07-24 at 1.55.12 PM.png /Users/me/Desktop/Screenshot 2026-07-24 at 1.56.00 PM.png";
		const pasted: string[] = [];
		editor.onPasteImagePath = path => {
			pasted.push(path);
		};

		editor.handleInput(bracketedPaste(dropped));

		expect(pasted).toEqual([]);
		expect(editor.getText()).toBe(dropped);
	});
});
describe("CustomEditor configured paste image keys", () => {
	it("routes Ghostty Cmd+V kitty key events through the macOS image-paste default", () => {
		const { editor } = makeEditor();
		const onPasteImage = vi.fn();
		editor.onPasteImage = onPasteImage;
		editor.setActionKeys("app.clipboard.pasteImage", getDefaultPasteImageKeys("darwin"));
		setKittyProtocolActive(true);

		try {
			editor.handleInput("\x1b[118;9u");
		} finally {
			setKittyProtocolActive(false);
		}

		expect(onPasteImage).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});
});

describe("extractImagePathFromText (issue #3506)", () => {
	it("returns the path when the text is a single image or video file path", () => {
		expect(extractImagePathFromText("/tmp/screenshot.png")).toBe("/tmp/screenshot.png");
		expect(extractImagePathFromText("/Users/me/Pictures/photo.jpeg")).toBe("/Users/me/Pictures/photo.jpeg");
		expect(extractImagePathFromText("C:\\Users\\me\\img.gif")).toBe("C:\\Users\\me\\img.gif");
		expect(extractImagePathFromText("/Users/me/Movies/launch.mp4")).toBe("/Users/me/Movies/launch.mp4");
	});

	it("ignores surrounding whitespace from a clipboard read", () => {
		expect(extractImagePathFromText("  /tmp/photo.webp\n")).toBe("/tmp/photo.webp");
	});

	it("returns undefined for a bare filename (no explicit directory)", () => {
		// Mirrors the bracketed-paste contract: a bare `.png` filename is
		// almost always a project-relative reference the user wants as text,
		// not a clipboard-anchored attachment.
		expect(extractImagePathFromText("icon.png")).toBeUndefined();
	});

	it("returns undefined for non-image extensions", () => {
		expect(extractImagePathFromText("/tmp/report.csv")).toBeUndefined();
		expect(extractImagePathFromText("/tmp/notes.txt")).toBeUndefined();
	});

	it("returns undefined when the text contains anything beyond a single path", () => {
		expect(extractImagePathFromText("see /tmp/screenshot.png")).toBeUndefined();
		expect(extractImagePathFromText("/tmp/a.png /tmp/b.png")).toBeUndefined();
	});

	it("returns undefined for empty/whitespace-only input", () => {
		expect(extractImagePathFromText("")).toBeUndefined();
		expect(extractImagePathFromText("   ")).toBeUndefined();
	});

	it("decodes a `file://` URL to its filesystem path", () => {
		expect(extractImagePathFromText("file:///Users/me/Pictures/photo.png")).toBe("/Users/me/Pictures/photo.png");
	});

	it("recovers a single anchored image path containing unescaped spaces (macOS screenshot name)", () => {
		const macScreenshot = "/Users/me/Desktop/Screenshot 2026-06-25 at 1.23.45 PM.png";
		expect(extractImagePathFromText(macScreenshot)).toBe(macScreenshot);
		expect(extractImagePathFromText("~/Pictures/Cleanshot 2026-06-25 at 12.00.png")).toBe(
			"~/Pictures/Cleanshot 2026-06-25 at 12.00.png",
		);
		expect(extractImagePathFromText("C:\\Users\\me\\My Pictures\\img with space.jpg")).toBe(
			"C:\\Users\\me\\My Pictures\\img with space.jpg",
		);
	});

	it("returns undefined for two spaced paths the splitter could not separate", () => {
		// Only the whole-text pass survives the splitter here, and it must not
		// fuse the pair into one path the loader can never resolve.
		expect(extractImagePathFromText("/tmp/a.png /tmp/b shot.png")).toBeUndefined();
	});

	it("does not hijack prose that happens to contain a path-shaped fragment", () => {
		// The whole-text branch is gated on ABSOLUTE_PATH_PREFIX_REGEX, so a
		// non-anchored prefix ("see ...") never triggers it.
		expect(extractImagePathFromText("see /Users/me/Desktop/Screenshot 1.png")).toBeUndefined();
	});
});

describe("extractPastePathsFromText", () => {
	it("delegates to the same logic the bracketed variant uses for path detection", () => {
		expect(extractPastePathsFromText("/tmp/a.png /tmp/b.png")).toEqual(["/tmp/a.png", "/tmp/b.png"]);
		expect(extractPastePathsFromText("just text")).toBeUndefined();
	});
});

describe("extractImagePastePathsFromText (issue #6578)", () => {
	const MAC_SCREENSHOT =
		"/var/folders/xx/T/TemporaryItems/NSIRD_screencaptureui_ab/Screenshot 2026-07-24 at 1.55.12 PM.png";
	const WINDOWS_SPACED = "C:\\Users\\me\\My Pictures\\shot 1.png";

	// Every case must resolve identically on the stripped-marker route
	// (assembled pastes) and the bracketed route, since the latter now
	// delegates to the former.
	const cases: { name: string; text: string; expected: string[] | undefined }[] = [
		{ name: "a macOS screenshot path with unescaped spaces", text: MAC_SCREENSHOT, expected: [MAC_SCREENSHOT] },
		{ name: "a Windows drive path with unescaped spaces", text: WINDOWS_SPACED, expected: [WINDOWS_SPACED] },
		{
			name: "a home-anchored path with unescaped spaces",
			text: "~/Pictures/Cleanshot 2026-07-24 at 12.00.png",
			expected: ["~/Pictures/Cleanshot 2026-07-24 at 12.00.png"],
		},
		{
			name: "a shell-escaped spaced path",
			text: "/tmp/My\\ Photos/shot\\ 1.png",
			expected: ["/tmp/My Photos/shot 1.png"],
		},
		{
			name: "a double-quoted spaced path",
			text: '"/tmp/My Photos/shot 1.png"',
			expected: ["/tmp/My Photos/shot 1.png"],
		},
		{ name: "a spaced path with a non-image extension", text: "/tmp/my report 2026.csv", expected: undefined },
		{
			// Ends in a real image extension, so only the absolute-prefix
			// anchor keeps the whole-text fallback from swallowing the prose.
			name: "prose ending in a path-shaped fragment",
			text: "see /Users/me/Desktop/Screen Shot 1.png",
			expected: undefined,
		},
		{
			name: "two spaced image paths on separate lines",
			text: "/tmp/a shot.png\n/tmp/b shot.png",
			expected: undefined,
		},
		{
			name: "a bare spaced filename with no leading separator",
			text: "Screenshot 2026-07-24 at 1.55.12 PM.png",
			expected: undefined,
		},
		{
			name: "two POSIX paths dragged together when one has unescaped spaces",
			text: "/tmp/a.png /tmp/b shot.png",
			expected: undefined,
		},
		{
			name: "two macOS screenshots dragged together",
			text: `${MAC_SCREENSHOT} /var/folders/xx/T/TemporaryItems/NSIRD_screencaptureui_ab/Screenshot 2026-07-24 at 1.56.00 PM.png`,
			expected: undefined,
		},
		{
			name: "two home-anchored paths with unescaped spaces",
			text: "~/a.png ~/Pictures/b shot.png",
			expected: undefined,
		},
		{
			name: "two Windows drive paths with unescaped spaces",
			text: `C:\\Users\\me\\a.png ${WINDOWS_SPACED}`,
			expected: undefined,
		},
		{
			name: "two `file://` URLs with unescaped spaces",
			text: "file:///tmp/a.png file:///tmp/b shot.png",
			expected: undefined,
		},
		{
			name: "two UNC paths with unescaped spaces",
			text: "\\\\srv\\share\\a.png \\\\srv\\share\\b shot.png",
			expected: undefined,
		},
		{
			name: "a tab-separated pair of dragged paths",
			text: "/tmp/a.png\t/tmp/b shot.png",
			expected: undefined,
		},
		{
			name: "an absolute path followed by a dot-relative path with unescaped spaces",
			text: "/tmp/a.png ./b shot.png",
			expected: undefined,
		},
		{
			name: "an absolute path followed by a parent-relative path with unescaped spaces",
			text: "/tmp/a.png ../pics/b shot.png",
			expected: undefined,
		},
		{
			name: "a Windows drive path followed by a dot-relative path with unescaped spaces",
			text: "C:\\Users\\me\\a.png .\\b shot.png",
			expected: undefined,
		},
		{
			// The interior `Photos/shot` token after an unescaped space is the
			// shape of a spaced directory name, not of a second dragged path —
			// this is why bare relatives are not multi-path anchors.
			name: "a single path with an unescaped spaced directory name",
			text: "/Users/me/My Photos/shot 1.png",
			expected: ["/Users/me/My Photos/shot 1.png"],
		},
		{
			// The escape asserts the space belongs to the path, so the `/sub`
			// that follows is a component rather than a second drag payload.
			name: "a path whose escaped space precedes a slash-led component",
			text: "/tmp/odd dir\\ /sub/a b.png",
			expected: ["/tmp/odd dir /sub/a b.png"],
		},
		{
			// Splitter-success path: both segments are explicit, so the
			// whole-text pass never runs and the pair still attaches as two.
			name: "two explicit image paths the splitter can separate",
			text: "/tmp/a.png /tmp/b.png",
			expected: ["/tmp/a.png", "/tmp/b.png"],
		},
	];

	for (const { name, text, expected } of cases) {
		it(`${expected ? "recovers" : "rejects"} ${name} on both paste routes`, () => {
			expect(extractImagePastePathsFromText(text)).toEqual(expected);
			expect(extractBracketedImagePastePaths(bracketedPaste(text))).toEqual(expected);
		});
	}
});

describe("CustomEditor space-hold push-to-talk", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("types deliberate space taps without triggering, even several in a row", () => {
		const { editor, events } = makeEditor();
		feedSpaces(editor, 3, TAP_GAP_MS);
		expect(editor.getText()).toBe("   ");
		expect(events).toEqual([]);
	});

	it("recognizes a held bar from a steady fast cadence and tracks back the burst", () => {
		const { editor, events } = makeEditor();
		editor.handleInput("h");
		editor.handleInput("i");
		// Metronomic auto-repeat: the few pre-burst spaces typed are tracked back out when the hold is
		// recognized, leaving only the pre-burst text.
		feedSpaces(editor, SPACE_HOLD_MECHANICAL_RUN + 2, REPEAT_GAP_MS);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// Continued auto-repeat while the bar is held is swallowed: no spam, no re-trigger.
		feedSpaces(editor, 5, REPEAT_GAP_MS);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// An idle gap with no further repeats means the bar was released -> stop + transcribe.
		vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
		expect(events).toEqual(["start", "end"]);
	});

	it("does not trigger when the space bar is smashed at an irregular cadence", () => {
		const { editor, events } = makeEditor();
		// Fast but jittery, the way a human mashes — not the metronomic delta of OS auto-repeat.
		const gaps = [40, 95, 45, 100, 35, 90, 50, 105];
		feedGaps(editor, gaps);
		expect(events).toEqual([]);
		// Nothing is eaten: every smashed space still types a real space.
		expect(editor.getText()).toBe(" ".repeat(gaps.length));
	});

	it("does not trigger on steady but slow spacing", () => {
		const { editor, events } = makeEditor();
		// Even cadence, but slower than auto-repeat: consistent deltas alone must not start recording.
		feedSpaces(editor, 6, TAP_GAP_MS);
		expect(events).toEqual([]);
		expect(editor.getText()).toBe(" ".repeat(6));
	});

	it("does not trigger when a non-space breaks the run", () => {
		const { editor, events } = makeEditor();
		// Each partial run climbs the mechanical counter one short of the threshold; the non-space
		// resets it so they never combine into a hold.
		feedSpaces(editor, 3, REPEAT_GAP_MS);
		editor.handleInput("x");
		feedSpaces(editor, 3, REPEAT_GAP_MS);
		expect(events).toEqual([]);
	});

	it("leaves the space bar typing normally when the gesture is disabled", () => {
		const { editor, events } = makeEditor();
		editor.sttHoldEnabled = () => false;
		feedSpaces(editor, 8, REPEAT_GAP_MS);
		expect(editor.getText()).toBe(" ".repeat(8));
		expect(events).toEqual([]);
	});
});

describe("CustomEditor latched hands-free gesture", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Editor wired for both space gestures; `handsFree` flips the latch-owns-the-mic gate. */
	function makeGestureEditor() {
		const editor = new CustomEditor(getEditorTheme());
		const events: string[] = [];
		const tapCounts: number[] = [];
		let handsFree = false;
		editor.sttHoldEnabled = () => true;
		editor.onSpaceHoldStart = () => events.push("start");
		editor.onSpaceHoldEnd = () => events.push("end");
		editor.onSpaceTapToggle = taps => {
			tapCounts.push(taps);
			events.push("tap");
		};
		editor.handsFreeActive = () => handsFree;
		return {
			editor,
			events,
			tapCounts,
			setHandsFree(value: boolean) {
				handsFree = value;
			},
		};
	}

	it("latches on a three-tap burst and leaves no spaces in the composer", () => {
		const { editor, events, tapCounts } = makeGestureEditor();
		editor.handleInput("hi");
		feedTaps(editor, SPACE_TAP_COUNT);
		// The transcript belongs to the dictation, not to three typed spaces.
		expect(editor.getText()).toBe("hi");
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);
		// Push-to-talk never fired: this is the latch, not a hold.
		expect(events).toEqual(["tap"]);
	});

	it("keeps typing the double-space-after-a-period habit instead of latching", () => {
		const { editor, tapCounts } = makeGestureEditor();
		// Two taps then prose: the burst is over and both spaces stay.
		feedTaps(editor, 2);
		editor.handleInput("x");
		expect(editor.getText()).toBe("  x");
		expect(tapCounts).toEqual([]);
	});

	it("does not latch when the taps are spread beyond the gesture window", () => {
		const { editor, tapCounts } = makeGestureEditor();
		feedGaps(editor, [SPACE_TAP_GAP_MS + 100, SPACE_TAP_GAP_MS + 100, SPACE_TAP_GAP_MS + 100]);
		expect(editor.getText()).toBe("   ");
		expect(tapCounts).toEqual([]);
	});

	it("swallows the taps past the burst so a longer burst toggles the latch only once", () => {
		const { editor, tapCounts } = makeGestureEditor();
		feedTaps(editor, SPACE_TAP_COUNT + 3);
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);
		expect(editor.getText()).toBe("");
	});

	it("still recognizes a held bar as push-to-talk, not as taps", () => {
		const { editor, events, tapCounts } = makeGestureEditor();
		feedSpaces(editor, SPACE_HOLD_MECHANICAL_RUN + 2, REPEAT_GAP_MS);
		expect(events).toEqual(["start"]);
		expect(tapCounts).toEqual([]);
	});

	it("types spaces instead of starting push-to-talk while the latch owns the mic", () => {
		const { editor, events, tapCounts, setHandsFree } = makeGestureEditor();
		setHandsFree(true);
		// A held bar during dictation must not cut the session off mid-sentence.
		feedSpaces(editor, 5, REPEAT_GAP_MS);
		expect(events).toEqual([]);
		expect(editor.getText()).toBe(" ".repeat(5));

		// Two taps must not toggle prematurely or delete earlier held spaces.
		feedTaps(editor, 2);
		expect(tapCounts).toEqual([]);
		expect(editor.getText()).toBe(" ".repeat(7));

		// The third tap toggles the latch and rolls back only the 3 burst taps.
		feedTaps(editor, 1);
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);
		expect(editor.getText()).toBe(" ".repeat(5));
	});

	it("rolls back only the spaces the burst typed", () => {
		const { editor, tapCounts } = makeGestureEditor();
		// The pinned smash cadence types every one of these spaces; the burst that follows must take
		// back its own taps and nothing else.
		const smashed = [40, 95, 45, 100, 35, 90, 50, 105];
		feedGaps(editor, smashed);
		feedTaps(editor, SPACE_TAP_COUNT);
		expect(editor.getText()).toBe(" ".repeat(smashed.length));
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);
	});

	it("never deletes text a paste put between the taps", () => {
		const { editor, tapCounts } = makeGestureEditor();
		editor.handleInput("hi");
		feedTaps(editor, 2);
		// A paste lands mid-burst: the roll-back may only take the burst's own space.
		editor.handleInput(bracketedPaste("world"));
		feedTaps(editor, 1);
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);
		expect(editor.getText()).toBe("hi  world");
	});

	it("never deletes whitespace a paste put between the taps", () => {
		const { editor, tapCounts } = makeGestureEditor();
		editor.handleInput("hi");
		feedTaps(editor, 2);
		// The pasted payload ends in spaces of its own: counting trailing spaces would delete them.
		editor.handleInput(bracketedPaste("world  "));
		feedTaps(editor, 1);
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);
		expect(editor.getText()).toBe("hi  world  ");
	});

	it("never deletes whitespace a paste put between earlier taps in the burst", () => {
		const { editor, tapCounts } = makeGestureEditor();
		editor.handleInput("hi");
		feedGaps(editor, [TAP_GAP_MS]);
		// An intervening paste with trailing whitespace lands between Tap 1 and Tap 2:
		editor.handleInput(bracketedPaste("world  "));
		feedGaps(editor, [TAP_GAP_MS + 60, TAP_GAP_MS]);
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);
		expect(editor.getText()).toBe("hi world  ");
	});

	it("rolls back tapped spaces on an earlier line in multiline text", () => {
		const { editor, tapCounts } = makeGestureEditor();
		editor.setText("line 1\nline 2");
		editor.moveToMessageStart();
		editor.moveToLineEnd();
		expect(editor.getCursor()).toEqual({ line: 0, col: 6 });

		feedTaps(editor, SPACE_TAP_COUNT);
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);
		expect(editor.getText()).toBe("line 1\nline 2");
	});

	it("toggles the latch back off with a later burst, past the swallow window", () => {
		const { editor, tapCounts } = makeGestureEditor();
		feedTaps(editor, SPACE_TAP_COUNT);
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);

		// Taps that continue the burst that just fired are swallowed: no second toggle...
		feedTaps(editor, SPACE_TAP_COUNT);
		expect(tapCounts).toEqual([SPACE_TAP_COUNT]);

		// ...and once the window has passed, the next burst belongs to the latch's off switch.
		vi.advanceTimersByTime(SPACE_TAP_GAP_MS + 1);
		feedTaps(editor, SPACE_TAP_COUNT);
		expect(tapCounts).toEqual([SPACE_TAP_COUNT, SPACE_TAP_COUNT]);
	});

	it("holds the burst open on an exactly-window gap and resets one millisecond past it", () => {
		const exact = makeGestureEditor();
		// Both gaps sit on the window edge and still vary like a human's would.
		feedGaps(exact.editor, [SPACE_TAP_GAP_MS, SPACE_TAP_GAP_MS - 60, SPACE_TAP_GAP_MS - 20]);
		expect(exact.tapCounts).toEqual([SPACE_TAP_COUNT]);

		const past = makeGestureEditor();
		feedGaps(past.editor, [SPACE_TAP_GAP_MS + 1, SPACE_TAP_GAP_MS + 1, SPACE_TAP_GAP_MS + 1]);
		expect(past.editor.getText()).toBe("   ");
		expect(past.tapCounts).toEqual([]);
	});

	it("refuses a metronomic burst inside the tap band as a slow held bar, not taps", () => {
		const { editor, events, tapCounts } = makeGestureEditor();
		// A slow OS key-repeat rate looks exactly like this: several spaces, same gap every time.
		// Holding the bar must keep typing (the pre-gesture behavior) instead of latching.
		feedGaps(editor, [200, 201, 199, 200, 202, 198]);
		expect(tapCounts).toEqual([]);
		expect(events).toEqual([]);
		expect(editor.getText()).toBe(" ".repeat(6));
	});
});
