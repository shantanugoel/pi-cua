/**
 * Regression tests for screenshot DELIVERY, not just capture.
 *
 * The bug these exist for: every capture was real, hashed, and registered, and the
 * model was told so in JSON — while the pixels went nowhere. Over MCP the driver puts a
 * screenshot in an `image` CONTENT BLOCK and leaves only `screenshot_width/height` in
 * structuredContent, so a client that reads text + structuredContent reports a
 * screenshot it never delivered. Same root cause then showed up as
 * `screenshot_context_missing` on `zoom` and on window-local `x,y`, because those
 * resolved over a one-shot CLI transport whose implicit session owns no screenshot.
 *
 * Acceptance (from the field report), run against a live driver:
 *   1. observe mode:"window" with include_accessibility_tree:false  <- the empty-tree case
 *      where the screenshot is the ONLY signal
 *   2. assert an image/png content block whose sha256 and w/h match what the result
 *      reports
 *   3. immediately zoom the same window: must return an image, not
 *      screenshot_context_missing
 *
 *   node test-image-delivery.ts
 */
import { createHash } from "node:crypto";
import { createJiti } from "/Users/shantanugoel/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
	console.log(`${pass ? "ok  " : "FAIL"} ${label.padEnd(58)} ${detail}`);
	if (!pass) failures++;
}

const image: any = await jiti.import(new URL("./src/image.ts", import.meta.url).href);

// ---------------------------------------------------------------- unit: image.ts

// 1x1 PNG. Hand-decoded so a broken header reader cannot pass by accident.
const PNG_1x1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
check("sniff png", image.sniffMimeType(Buffer.from(PNG_1x1, "base64")) === "image/png");
{
	const one = image.finalizeImage({ data: PNG_1x1, mimeType: "image/png" });
	check("finalize reads 1x1 from the header", one?.width === 1 && one?.height === 1, `${one?.width}x${one?.height}`);
	check(
		"finalize hashes the delivered bytes",
		one?.sha256 === createHash("sha256").update(Buffer.from(PNG_1x1, "base64")).digest("hex"),
		one?.sha256?.slice(0, 12),
	);
}
{
	// The CLI shape: base64 inline in the payload. It must become an image, never text.
	const cli = { capture_id: "c1", screenshot_width: 1, screenshot_height: 1, screenshot_mime_type: "image/png", screenshot_png_b64: PNG_1x1 };
	const split = image.collectImages(cli, []);
	check("collectImages lifts CLI base64 out of the payload", split.images.length === 1 && split.payload.screenshot_png_b64 === undefined);
	check("collectImages keeps the metadata", split.payload.capture_id === "c1" && split.payload.screenshot_width === 1);
	// The MCP shape: an image content block, no base64 field anywhere.
	const mcp = image.collectImages({ screenshot_width: 1, screenshot_height: 1 }, [{ data: PNG_1x1, mimeType: "image/png" }]);
	check("collectImages takes MCP image blocks", mcp.images.length === 1 && mcp.images[0].mimeType === "image/png");
}
{
	const limits = { maxBytes: 100_000, maxWidth: 2000, maxHeight: 2000 };
	const big = { data: "A".repeat(200_000), mimeType: "image/png", bytes: 150_000, width: 100, height: 100, sha256: "x" };
	check("overByteBudget flags an oversized payload", /over the 0.10 MB inline-image budget/.test(image.overByteBudget(big, limits)));
	check("suggestLongEdge shrinks instead of rescaling", image.suggestLongEdge(1000, big, limits) === 632, String(image.suggestLongEdge(1000, big, limits)));
	check("suggestLongEdge refuses to re-request the same frame", image.suggestLongEdge(512, big, limits) === 0);
	const wide = { data: "A".repeat(1000), mimeType: "image/png", bytes: 700, width: 3840, height: 2160, sha256: "x" };
	check("oversized dimensions are advisory, never a re-capture", /resize profile/.test(image.overDimensionProfile(wide, limits)) && image.overByteBudget(wide, limits) === null && image.suggestLongEdge(3840, wide, limits) === 0);
}

// --------------------------------------------------- harness: the extension itself

const tools: Record<string, any> = {};
const active: string[] = [];
const pi: any = {
	registerTool: (t: any) => {
		tools[t.name] = t;
	},
	registerCommand: () => {},
	registerFlag: () => {},
	registerShortcut: () => {},
	registerProvider: () => {},
	getActiveTools: () => active,
	setActiveTools: (names: string[]) => {
		active.length = 0;
		active.push(...names);
	},
	on: () => () => {},
	events: { emit: () => {}, on: () => () => {} },
	appendEntry: () => {},
	sendMessage: async () => {},
	sendUserMessage: async () => {},
};
const mod: any = await jiti.import("./extensions/cua-driver.ts");
mod.default(pi);

// ctx.model carries the inline-image budget the delivery path must respect.
const ctx: any = {
	hasUI: true,
	mode: "print",
	cwd: process.cwd(),
	signal: undefined,
	isIdle: () => true,
	model: { inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 } } } },
	ui: { notify: () => {}, setStatus: () => {}, confirm: async () => true, select: async () => "Yes" },
};

const driver: any = await jiti.import(new URL("./src/driver.ts", import.meta.url).href);
const policy: any = await jiti.import(new URL("./src/policy.ts", import.meta.url).href);
const resolved = driver.resolveBinary(null);
if (!resolved.path) {
	console.log("\nSKIP: cua-driver not installed — unit checks above still ran");
	process.exit(failures === 0 ? 0 : 1);
}
const daemon = await driver.daemonStatus(resolved.path);
if (!daemon.data.running) {
	console.log("\nSKIP: driver daemon not running — unit checks above still ran");
	process.exit(failures === 0 ? 0 : 1);
}
const perms = await driver.permissionsStatus(resolved.path);
if (!perms.data.accessibility || !perms.data.screenRecording) {
	console.log("\nSKIP: TCC permissions not granted — unit checks above still ran");
	process.exit(failures === 0 ? 0 : 1);
}

await tools.cua_enable.execute("t0", {}, undefined, undefined, ctx);

const textOf = (result: any) => (result.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const imagesOf = (result: any) => (result.content ?? []).filter((b: any) => b.type === "image");

// Pick any on-screen window. The test is about pixels, not about one particular app.
const windows = await tools.cua_observe.execute("t1", { mode: "windows" }, undefined, undefined, ctx);
const rows = windows.details.rows ?? [];
const target = rows.find((r: any) => r.on_screen);
if (!target) {
	console.log("\nSKIP: no on-screen window to capture");
	process.exit(failures === 0 ? 0 : 1);
}
console.log(`\ntarget: pid=${target.pid} window_id=${target.window_id} title=${JSON.stringify(String(target.title).slice(0, 40))}`);

// Step 1: the empty-AX-tree case from the report — pixels are the only possible signal.
const observed = await tools.cua_observe.execute(
	"t2",
	{ mode: "window", pid: target.pid, window_id: target.window_id, include_accessibility_tree: false },
	undefined,
	undefined,
	ctx,
);
const blocks = imagesOf(observed);
const body = textOf(observed);
const reported = JSON.parse(body.slice(body.indexOf("{")));
check("observe attaches an image content block", blocks.length === 1, `${blocks.length} block(s)`);
check("observe reports a capture_id and snapshot_id", !!reported.capture_id && !!reported.snapshot_id, `${reported.capture_id} / ${reported.snapshot_id}`);
check("no base64 blob leaks into the text", !body.includes("screenshot_png_b64") && !/[A-Za-z0-9+/]{2000,}/.test(body), `${body.length} chars of text`);

if (blocks.length) {
	const bytes = Buffer.from(blocks[0].data, "base64");
	const delivered = image.finalizeImage({ data: blocks[0].data, mimeType: blocks[0].mimeType });
	const sha = createHash("sha256").update(bytes).digest("hex");
	check("delivered image hashes to what the result reports", sha === reported.screenshot?.sha256 && sha === observed.details.screenshot?.sha256, sha.slice(0, 16));
	check(
		"delivered pixels match reported screenshot_width/height",
		delivered.width === reported.screenshot.width && delivered.height === reported.screenshot.height && delivered.width === reported.screenshot_width && delivered.height === reported.screenshot_height,
		`${delivered.width}x${delivered.height} vs driver ${reported.screenshot_width}x${reported.screenshot_height}`,
	);
	check("delivered image is a real decodable format", blocks[0].mimeType === "image/png" && image.sniffMimeType(bytes) === "image/png", blocks[0].mimeType);
}

// Step 2: zoom on the same connection. Before the fix this was screenshot_context_missing
// on every call, because the action went over a fresh CLI transport whose implicit
// session owns no screenshot.
const longEdge = Math.max(Number(reported.screenshot_width ?? 0), Number(reported.screenshot_height ?? 0));
const zoomed = await tools.cua_act.execute(
	"t3",
	{
		action: "zoom",
		target: { pid: target.pid, window_id: target.window_id },
		args: { x1: 0, y1: 0, x2: Math.max(1, Math.floor(longEdge / 2)), y2: Math.max(1, Math.floor(longEdge / 4)) },
		note: "regression test: zoom the top-left quadrant",
	},
	undefined,
	undefined,
	ctx,
);
const zoomText = textOf(zoomed);
check("zoom returns an image, not screenshot_context_missing", imagesOf(zoomed).length === 1 && !zoomText.includes("screenshot_context_missing"), zoomText.slice(0, 90).replace(/\n/g, " "));
check("zoom is classified read-only (no consent prompt per step)", policy.classify("zoom") === "observe" && policy.checkTool("zoom", { policy: { denyTools: [], allowMutations: true, confirmActions: true } }).requiresConsent === false, policy.classify("zoom"));
{
	const zoomImage = imagesOf(zoomed)[0];
	const zoomed2 = zoomImage ? image.finalizeImage({ data: zoomImage.data, mimeType: zoomImage.mimeType }) : null;
	check("zoom image is a decodable JPEG with real dimensions", !!zoomed2?.width && !!zoomed2?.height && zoomed2.mimeType === "image/jpeg", zoomed2 ? `${zoomed2.width}x${zoomed2.height} ${zoomed2.mimeType}` : "none");
}

// Step 2b: from_zoom must resolve the zoom context the previous call created. The point
// is far outside the crop, so the driver refuses it before dispatch — the translated
// coordinates in its message prove the crop was understood, without touching the app.
let zoomTranslate = "";
try {
	await tools.cua_act.execute(
		"t3b",
		{
			action: "click",
			target: { pid: target.pid, window_id: target.window_id, x: 9_000_000, y: 9_000_000 },
			args: { from_zoom: true },
			note: "regression test: from_zoom translation must resolve, then be refused as out of bounds",
		},
		undefined,
		undefined,
		ctx,
	);
	zoomTranslate = "(no error thrown)";
} catch (error) {
	zoomTranslate = String(error instanceof Error ? error.message : error);
}
check(
	"from_zoom resolves the zoom context (no zoom_context_missing)",
	!zoomTranslate.includes("zoom_context_missing") && !zoomTranslate.includes("screenshot_context_missing"),
	zoomTranslate.slice(0, 120).replace(/\n/g, " "),
);

// Step 3: a read-only zoom must not burn the capture a later step wants to bind to.
let regionsError = "";
try {
	const regions = await tools.cua_observe.execute(
		"t4",
		{ mode: "regions", capture_id: reported.capture_id, pid: target.pid, window_id: target.window_id, max_regions: 3 },
		undefined,
		undefined,
		ctx,
	);
	check("the capture survives a zoom (still resolvable for regions)", !textOf(regions).includes("unknown"), textOf(regions).slice(0, 70).replace(/\n/g, " "));
} catch (error) {
	regionsError = String(error instanceof Error ? error.message : error);
	check("the capture survives a zoom (still resolvable for regions)", regionsError.includes("not_installed"), regionsError.slice(0, 100).replace(/\n/g, " "));
}

// Step 4: window-local pixels must resolve against the session that took the snapshot.
// Out-of-bounds coordinates prove it without touching anything: the driver refuses a
// point outside the window frame before dispatch.
const fresh = await tools.cua_observe.execute(
	"t5",
	{ mode: "window", pid: target.pid, window_id: target.window_id, include_accessibility_tree: false },
	undefined,
	undefined,
	ctx,
);
const freshReported = JSON.parse(textOf(fresh).slice(textOf(fresh).indexOf("{")));
check("re-observation issues a live capture with pixels", !!freshReported.capture_id && imagesOf(fresh).length === 1, freshReported.capture_id);
let pixelError = "";
try {
	await tools.cua_act.execute(
		"t6",
		{
			action: "click",
			target: { pid: target.pid, window_id: target.window_id, x: 1_000_000, y: 1_000_000 },
			note: "regression test: out-of-bounds click must be refused, never dispatched",
		},
		undefined,
		undefined,
		ctx,
	);
	pixelError = "(no error thrown)";
} catch (error) {
	pixelError = String(error instanceof Error ? error.message : error);
}
check(
	"window-local x,y resolves screenshot context (no screenshot_context_missing)",
	!pixelError.includes("screenshot_context_missing"),
	pixelError.slice(0, 120).replace(/\n/g, " "),
);

// Step 5: the cheap tree-only re-index must say it has no pixels instead of implying
// them. Last, because a snapshot without a screenshot replaces the session's screenshot
// context and would break the steps above.
const treeOnly = await tools.cua_observe.execute(
	"t7",
	{ mode: "window", pid: target.pid, window_id: target.window_id, include_screenshot: false },
	undefined,
	undefined,
	ctx,
);
const treeOnlyBody = textOf(treeOnly);
check(
	"include_screenshot:false attaches no image and says why",
	imagesOf(treeOnly).length === 0 && treeOnlyBody.includes('"present": false') && treeOnlyBody.includes("include_screenshot:false was requested"),
	treeOnlyBody.slice(0, 70).replace(/\n/g, " "),
);

console.log(failures === 0 ? "\nall image-delivery checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);