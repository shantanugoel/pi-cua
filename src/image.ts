/**
 * Screenshot delivery for model-facing tool results.
 *
 * The driver returns the same PNG through two different shapes, and getting this
 * wrong fails silently:
 *
 *   - MCP `tools/call`: the image is an `image` CONTENT BLOCK (`{type:"image",
 *     data, mimeType}`) and `structuredContent` carries only metadata — measured on
 *     0.30.4, `get_window_state` returns an image block plus a structured payload with
 *     `screenshot_width/height/mime_type` and NO base64 field at all.
 *   - one-shot CLI `call --json`: the same bytes arrive inline as
 *     `screenshot_png_b64` (2.49 MB of base64 for a 1568x867 window capture).
 *
 * So reading `screenshot_png_b64` off the structured payload reports a screenshot that
 * was never delivered, and stringifying the CLI payload buries megabytes of base64 in
 * the model's TEXT. This module normalises both shapes into real image content and
 * verifies what it is holding.
 *
 * It deliberately never rescales. Pixel actions are expressed in the pixels of the
 * image the model was handed (the driver translates window-local screenshot pixels
 * using ITS snapshot's geometry, measured: 99999 px -> 121937.6 pt at scale 1.2194),
 * so a silent rescale between capture and delivery would mis-aim every click while
 * looking completely healthy. If a capture is too big for the model's inline budget we
 * re-ask the DRIVER for a smaller one, so reported geometry and delivered pixels stay
 * the same image.
 */

import { createHash } from "node:crypto";

export interface RawImage {
	data: string;
	mimeType: string;
}

export interface DeliveredImage extends RawImage {
	/** Decoded byte length. */
	bytes: number;
	/** Read back out of the image itself, not trusted from metadata. */
	width?: number;
	height?: number;
	sha256: string;
}

export interface InlineLimits {
	/** Base64 payload ceiling for one inline image. */
	maxBytes: number;
	maxWidth: number;
	maxHeight: number;
}

/**
 * Matches Pi's own default for images it attaches (`read`): 4.5 MB of base64 leaves
 * headroom below Anthropic's 5 MB limit. Overridable per model via
 * `ctx.model.inputLimits.images.resize`.
 */
export const DEFAULT_LIMITS: InlineLimits = { maxBytes: 4.5 * 1024 * 1024, maxWidth: 2000, maxHeight: 2000 };

/** Inline base64 screenshot fields the driver has used (CLI shape). */
const B64_FIELDS = ["screenshot_png_b64", "screenshot_b64", "screenshot_jpeg_b64", "image_b64", "png_b64"];

/** Magic-number sniff. Never trust a `mimeType` we cannot confirm. */
export function sniffMimeType(bytes: Buffer): string | null {
	if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	if (bytes.length > 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
	return null;
}

/** Intrinsic size, read from the header. Null when the format is exotic or truncated. */
export function readDimensions(bytes: Buffer, mimeType: string): { width: number; height: number } | null {
	try {
		if (mimeType === "image/png" && bytes.length > 24 && bytes.subarray(12, 16).toString("latin1") === "IHDR") {
			return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
		}
		if (mimeType === "image/jpeg") {
			let offset = 2;
			while (offset + 9 < bytes.length) {
				if (bytes[offset] !== 0xff) {
					offset++;
					continue;
				}
				const marker = bytes[offset + 1];
				// SOF0..SOF3 and SOF5..SOF7 carry the frame size; C4/C8/CC are DHT/DAC/DHT-family.
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
				}
				offset += 2 + bytes.readUInt16BE(offset + 2);
			}
			return null;
		}
		if (mimeType === "image/gif" && bytes.length > 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
		if (mimeType === "image/webp" && bytes.length > 30) {
			const fourcc = bytes.subarray(12, 16).toString("latin1");
			if (fourcc === "VP8X") {
				return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
			}
			if (fourcc === "VP8L") {
				const bits = bytes.readUInt32LE(21);
				return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
			}
			if (fourcc === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
		}
	} catch {
		/* malformed header -> unknown */
	}
	return null;
}

/**
 * Split a driver payload into (JSON-safe payload, images). MCP image blocks come first
 * because they are the primary shape; inline base64 fields are removed from the payload
 * so a megabyte of base64 can never reach the model as text.
 */
export function collectImages(
	payload: Record<string, unknown>,
	blocks: RawImage[] = [],
): { payload: Record<string, unknown>; images: RawImage[] } {
	const images: RawImage[] = [];
	for (const block of blocks) {
		if (typeof block?.data === "string" && block.data.length) images.push({ data: block.data, mimeType: block.mimeType || "image/png" });
	}
	const hinted =
		typeof payload.screenshot_mime_type === "string"
			? payload.screenshot_mime_type
			: typeof payload.mime_type === "string"
				? payload.mime_type
				: "image/png";
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (B64_FIELDS.includes(key) && typeof value === "string" && value.length) {
			images.push({ data: value, mimeType: hinted });
			continue;
		}
		clean[key] = value;
	}
	return { payload: clean, images };
}

/** Decode, sniff, measure and hash one image so the result can vouch for what it sent. */
export function finalizeImage(image: RawImage): DeliveredImage | null {
	const bytes = Buffer.from(image.data, "base64");
	if (!bytes.length) return null;
	const mimeType = sniffMimeType(bytes) ?? image.mimeType;
	const size = readDimensions(bytes, mimeType);
	return {
		data: image.data,
		mimeType,
		bytes: bytes.length,
		width: size?.width,
		height: size?.height,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

/**
 * Hard blocker: a payload over the provider's inline ceiling gets the whole request
 * rejected, so it is worth a re-capture.
 */
export function overByteBudget(image: DeliveredImage, limits: InlineLimits): string | null {
	if (image.data.length > limits.maxBytes) {
		return `base64 payload is ${(image.data.length / 1024 / 1024).toFixed(2)} MB, over the ${(limits.maxBytes / 1024 / 1024).toFixed(2)} MB inline-image budget`;
	}
	return null;
}

/**
 * Advisory only. Pi's resize profile is a context-size policy for images entering
 * history, not a provider limit, and shrinking a capture is exactly what makes small UI
 * labels unreadable to both the model and OCR. So an oversized frame is REPORTED, never
 * silently re-captured or resampled — the caller decides whether the tokens are worth it
 * via `max_image_dimension`.
 */
export function overDimensionProfile(image: DeliveredImage, limits: InlineLimits): string | null {
	if (image.width && image.height && (image.width > limits.maxWidth || image.height > limits.maxHeight)) {
		return `${image.width}x${image.height} is above the model's ${limits.maxWidth}x${limits.maxHeight} resize profile; pass max_image_dimension for a cheaper capture`;
	}
	return null;
}

/**
 * Long edge to re-ask the driver for. Base64 size scales roughly with pixel area, so
 * sqrt is the right correction; 0.8 keeps a margin for content that compresses worse.
 */
export function suggestLongEdge(longEdge: number, image: DeliveredImage, limits: InlineLimits): number {
	const current = Math.max(1, Math.floor(longEdge) || Math.max(image.width ?? 0, image.height ?? 0) || 1);
	const next = Math.floor(current * Math.sqrt((limits.maxBytes * 0.8) / Math.max(1, image.data.length)));
	if (!Number.isFinite(next) || next >= current) return 0;
	// Never go below the floor, and never pretend a re-capture will help when the floor
	// is already at or above what we have — that would re-request the same frame.
	if (next < 512) return current > 512 ? 512 : 0;
	return next;
}

/** Model-facing description of one delivered image. */
export function imageMeta(image: DeliveredImage): Record<string, unknown> {
	return {
		present: true,
		mime_type: image.mimeType,
		width: image.width,
		height: image.height,
		bytes: image.bytes,
		base64_chars: image.data.length,
		sha256: image.sha256,
	};
}