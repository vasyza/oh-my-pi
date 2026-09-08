const WAV_HEADER_BYTES = 44;
const PCM16_FORMAT = 1;
const BITS_PER_SAMPLE = 16;
const INT16_MAX = 32_767;
const INT16_MIN = -32_768;

function writeWavHeader(view: DataView, sampleRate: number, dataBytes: number): void {
	const channels = 1;
	const byteRate = sampleRate * channels * (BITS_PER_SAMPLE / 8);
	const blockAlign = channels * (BITS_PER_SAMPLE / 8);
	// RIFF chunk descriptor
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true); // file size minus the first 8 bytes
	writeAscii(view, 8, "WAVE");

	// fmt sub-chunk
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // PCM fmt chunk size
	view.setUint16(20, PCM16_FORMAT, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, BITS_PER_SAMPLE, true);

	// data sub-chunk
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);
}

/**
 * Quantize Float32 mono PCM samples ([-1, 1], clamped) to signed 16-bit
 * little-endian bytes. Shared by streaming transports (one encode per chunk)
 * and batch WAV assembly; no gain/AGC is applied.
 */
export function encodePcm16(samples: Float32Array): Uint8Array {
	const buffer = new ArrayBuffer(samples.length * 2);
	const view = new DataView(buffer);
	for (let i = 0; i < samples.length; i += 1) {
		const sample = samples[i]!;
		const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
		view.setInt16(
			i * 2,
			clamped < 0
				? Math.max(INT16_MIN, Math.round(clamped * -INT16_MIN))
				: Math.min(INT16_MAX, Math.round(clamped * INT16_MAX)),
			true,
		);
	}
	return new Uint8Array(buffer);
}

/**
 * Assemble a mono PCM16 WAV from already-encoded little-endian chunks with a
 * single allocation and sequential copy. Used for batch upload of a recorded
 * clip without re-quantizing or decoding back through Float32.
 */
export function encodeWavFromPcm16(chunks: readonly Uint8Array[], sampleRate: number): Uint8Array {
	let dataBytes = 0;
	for (const chunk of chunks) dataBytes += chunk.byteLength;
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(buffer);
	writeWavHeader(view, sampleRate, dataBytes);
	const out = new Uint8Array(buffer);
	let offset = WAV_HEADER_BYTES;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Assemble a mono PCM16 WAV byte buffer from Float32 PCM samples (the shape
 * transformers.js `RawAudio` emits: normalized [-1, 1] amplitudes plus a sample
 * rate). No external encoder is involved — we write a canonical 44-byte RIFF/
 * WAVE header followed by little-endian signed 16-bit samples. Samples are
 * clamped before quantization so out-of-range float values do not wrap.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
	return encodeWavFromPcm16([encodePcm16(samples)], sampleRate);
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
