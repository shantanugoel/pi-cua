/**
 * Opt-in installer for the optional `cua-perception` extension.
 *
 * Licensing, stated plainly because it is the whole reason this is opt-in:
 *
 *   The extension bundles an OmniParser icon detector (a fine-tuned Ultralytics YOLO
 *   from microsoft/OmniParser-v2.0) that is AGPL-3.0-only. The PP-OCRv5 text models are
 *   Apache-2.0 and ONNX Runtime is MIT. Cua Driver itself stays MIT either way, because
 *   it talks to the extension worker as a separate process over a protocol.
 *
 *   Attribution does not satisfy AGPL-3.0-only — its consideration is source
 *   availability, not credit. Redistributing the artifact means shipping the AGPL
 *   licence text, notices, model/source ledgers, SBOM, and the Corresponding Source
 *   (the converted ONNX plus the pinned source model and the conversion/export
 *   material), and AGPL section 13 can additionally apply to hosted offerings.
 *
 *   So pi-cua ships no perception bytes. This module makes the *user* fetch the signed
 *   artifact straight from Cua's own GitHub release, which keeps the full capability
 *   available without turning `npm install pi-cua` into a redistribution — and without
 *   putting a ~426 MB per-platform archive (catalogs also expire after one year) inside
 *   an npm tarball.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCuaDriver, type CuaResult } from "./driver.ts";

export const PERCEPTION_NOTICE = `cua-perception includes an AGPL-3.0-only component.

  OmniParser icon detector  AGPL-3.0-only   (microsoft/OmniParser-v2.0, fine-tuned Ultralytics YOLO)
  PP-OCRv5 det + rec        Apache-2.0
  ONNX Runtime              MIT
  Cua Driver itself         MIT (unchanged; the worker is a separate process)

Private use is unrestricted. Redistribution carries AGPL corresponding-source
obligations, and attribution alone does not satisfy them. pi-cua does not ship these
bytes: you are downloading the signed artifact directly from Cua's GitHub release.

Download size is roughly 426 MB for this platform.`;

const API = "https://api.github.com/repos/trycua/cua/releases?per_page=100";

export type Target =
	| "aarch64-apple-darwin"
	| "x86_64-apple-darwin"
	| "x86_64-unknown-linux-gnu"
	| "aarch64-unknown-linux-gnu"
	| "x86_64-pc-windows-msvc";

export function hostTarget(): Target | null {
	const arch = process.arch;
	if (process.platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : arch === "x64" ? "x86_64-apple-darwin" : null;
	if (process.platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : arch === "x64" ? "x86_64-unknown-linux-gnu" : null;
	if (process.platform === "win32") return arch === "x64" ? "x86_64-pc-windows-msvc" : null;
	return null;
}

export interface ReleaseInfo {
	tag: string;
	version: string;
	target: Target;
	catalogUrl: string;
	archiveUrl: string;
	sumsUrl: string | null;
	archiveName: string;
}

export async function findRelease(): Promise<CuaResult<ReleaseInfo>> {
	const target = hostTarget();
	if (!target) {
		return { ok: false, code: "unsupported_platform", message: `no published perception target for ${process.platform}/${process.arch}`, retryable: false };
	}
	const probe = await fetchLatestReleaseTag();
	if (!probe.ok) return probe;
	const tag = probe.data;
	const version = tag.replace(/^cua-perception-v/, "");
	const stem = `cua-perception-${version}-${target}`;
	const base = `https://github.com/trycua/cua/releases/download/${tag}`;
	return {
		ok: true,
		data: {
			tag,
			version,
			target,
			catalogUrl: `${base}/${stem}.catalog.json`,
			archiveUrl: `${base}/${stem}.tar.gz`,
			sumsUrl: `${base}/SHA256SUMS`,
			archiveName: `${stem}.tar.gz`,
		},
		raw: tag,
	};
}

async function fetchLatestReleaseTag(): Promise<CuaResult<string>> {
	try {
		const response = await fetch(API, { headers: { "user-agent": "pi-cua", accept: "application/vnd.github+json" } });
		if (!response.ok) return { ok: false, code: "release_lookup_failed", message: `GitHub returned HTTP ${response.status}`, retryable: true };
		const releases = (await response.json()) as Array<{ tag_name?: string; assets?: Array<{ name?: string }> }>;
		const target = hostTarget();
		for (const release of releases) {
			const tag = release.tag_name ?? "";
			if (!tag.startsWith("cua-perception-v")) continue;
			// Only offer a release that actually carries this platform's archive.
			const names = (release.assets ?? []).map((a) => a.name ?? "");
			if (target && names.some((n) => n.endsWith(`-${target}.tar.gz`))) return { ok: true, data: tag, raw: tag };
		}
		return { ok: false, code: "no_release", message: "no cua-perception release carries this platform's archive", retryable: false };
	} catch (error) {
		return { ok: false, code: "network", message: String(error instanceof Error ? error.message : error), retryable: true };
	}
}

export function cacheDir(): string {
	const dir = join(homedir(), ".cache", "pi-cua", "perception");
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function download(url: string, dest: string): Promise<CuaResult<string>> {
	try {
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok) return { ok: false, code: "download_failed", message: `HTTP ${response.status} for ${url}`, retryable: true };
		const bytes = Buffer.from(await response.arrayBuffer());
		writeFileSync(dest, bytes);
		return { ok: true, data: dest, raw: dest };
	} catch (error) {
		return { ok: false, code: "download_failed", message: String(error instanceof Error ? error.message : error), retryable: true };
	}
}

function sha256(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export interface InstallOutcome {
	ok: boolean;
	steps: string[];
	error?: string;
	hint?: string;
}

/**
 * Fetch the signed catalog + archive for this platform straight from Cua's release,
 * verify the digest, inspect, then install. `onProgress` keeps the UI responsive during
 * a several-hundred-megabyte download.
 */
export async function installPerception(
	binary: string,
	onProgress: (message: string) => void,
): Promise<InstallOutcome> {
	const steps: string[] = [];
	const record = (message: string) => {
		steps.push(message);
		onProgress(message);
	};

	const release = await findRelease();
	if (!release.ok) return { ok: false, steps, error: `${release.code}: ${release.message}` };
	const info = release.data;
	record(`release ${info.tag} · target ${info.target}`);

	const dir = cacheDir();
	const catalogPath = join(dir, `${info.version}-${info.target}.catalog.json`);
	const archivePath = join(dir, info.archiveName);
	const sumsPath = join(dir, "SHA256SUMS");

	if (!existsSync(archivePath)) {
		record("downloading catalog…");
		const catalog = await download(info.catalogUrl, catalogPath);
		if (!catalog.ok) return { ok: false, steps, error: `catalog: ${catalog.message}` };
		record("downloading ~426 MB archive (this is the slow part)…");
		const archive = await download(info.archiveUrl, archivePath);
		if (!archive.ok) return { ok: false, steps, error: `archive: ${archive.message}` };
		if (info.sumsUrl) await download(info.sumsUrl, sumsPath);
	} else {
		record(`reusing cached archive ${archivePath}`);
		if (!existsSync(catalogPath)) {
			const catalog = await download(info.catalogUrl, catalogPath);
			if (!catalog.ok) return { ok: false, steps, error: `catalog: ${catalog.message}` };
		}
	}

	if (existsSync(sumsPath)) {
		const line = readFileSync(sumsPath, "utf8")
			.split("\n")
			.find((l) => l.includes(info.archiveName));
		const expected = line?.trim().split(/\s+/)[0];
		if (expected) {
			const actual = sha256(archivePath);
			if (actual !== expected) {
				return { ok: false, steps, error: `SHA-256 mismatch for ${info.archiveName}; refusing to install`, hint: `expected ${expected}\nactual   ${actual}` };
			}
			record("sha256 verified");
		}
	}

	record("inspecting extension…");
	const inspected = await runCuaDriver(binary, ["extension", "inspect", "cua-perception", "--catalog", catalogPath], { timeoutMs: 120_000 });
	if (!inspected.ok) return { ok: false, steps, error: `inspect: ${inspected.message}`, hint: inspected.raw };
	record(outputOfSafe(inspected).slice(0, 400));

	record("installing…");
	const installed = await runCuaDriver(binary, ["extension", "install", "cua-perception", "--catalog", catalogPath], { timeoutMs: 600_000 });
	if (!installed.ok) return { ok: false, steps, error: `install: ${installed.message}`, hint: installed.raw };

	const status = await runCuaDriver(binary, ["extension", "status", "cua-perception"], { timeoutMs: 60_000 });
	record(outputOfSafe(status).slice(0, 300));
	return { ok: true, steps };
}

function outputOfSafe(result: CuaResult): string {
	return result.raw ?? (result.ok ? "" : result.message);
}

export async function removePerception(binary: string): Promise<CuaResult<string>> {
	const result = await runCuaDriver(binary, ["extension", "remove", "cua-perception"], { timeoutMs: 120_000 });
	if (!result.ok) return result;
	return { ...result, data: result.raw ?? "" };
}