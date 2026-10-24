// Pure release selection: pick the newest stable vX.Y.Z tag and validate
// its asset set. No network — unit tests drive this with recorded fixtures.

import { STABLE_TAG_RE, latestStable } from "@qntx/sync";
import type { Release } from "@qntx/sync";

import { SHA256_RE, TARGETS } from "./catalog.ts";
import type { LockEntry } from "./lock.ts";

export class SelectError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SelectError";
  }
}

export function isWindows(target: string): boolean {
  return target.endsWith("-pc-windows-msvc");
}

export function assetName(bin: string, version: string, target: string): string {
  return `${bin}-${version}-${target}.${isWindows(target) ? "zip" : "tar.gz"}`;
}

export type Selected = {
  version: string;
  tag: string;
  assets: Record<string, string>;
};

// GNU sha256sum emits `<hash>  <name>` (text mode) or `<hash> *<name>`
// (binary mode, e.g. Windows/macOS builds); some release workflows recorded
// the path as `dist/<name>` instead of the bare name.
const SHA_FILE_RE = /^([0-9a-f]{64}) [ *]([^\r\n]+?)[\r\n]*$/;

export function parseShaFile(content: string, expectedName: string): string {
  const m = SHA_FILE_RE.exec(content);
  if (m === null) {
    throw new SelectError(`malformed .sha256 file for ${expectedName}`);
  }
  const hash = m[1] ?? "";
  const name = m[2] ?? "";
  if (name !== expectedName && name !== `dist/${expectedName}`) {
    throw new SelectError(`.sha256 names "${name}", expected "${expectedName}"`);
  }
  if (!SHA256_RE.test(hash)) {
    throw new SelectError(`bad sha256 "${hash}" in ${expectedName}.sha256`);
  }
  return hash;
}

export async function selectRelease(
  repo: string,
  bin: string,
  releases: Release[],
  previous: LockEntry | undefined,
  force: boolean,
  shaFileText: (release: Release, asset: string) => Promise<string> | string,
): Promise<Selected> {
  const best = latestStable(releases);
  const m = best === undefined ? null : STABLE_TAG_RE.exec(best.tag_name);
  if (best === undefined || m === null) {
    throw new SelectError(`${repo}: no stable vX.Y.Z release`);
  }
  const version = `${m[1] ?? "0"}.${m[2] ?? "0"}.${m[3] ?? "0"}`;

  const byName = new Map(best.assets.map((a) => [a.name, a]));
  // Any asset shaped like one of ours (<bin>-<version>-*) but not matching
  // an expected name indicates a naming drift — fail loudly instead of
  // silently dropping a platform (as happened to x86_64-pc-windows-msvc).
  const expected = new Set<string>();
  for (const target of TARGETS) {
    const name = assetName(bin, version, target);
    expected.add(name);
    expected.add(`${name}.sha256`);
  }
  for (const a of best.assets) {
    if (a.name.startsWith(`${bin}-${version}-`) && !expected.has(a.name)) {
      throw new SelectError(`${repo}@${best.tag_name}: unrecognized asset ${a.name}`);
    }
  }
  const assets: Record<string, string> = {};
  for (const target of TARGETS) {
    const name = assetName(bin, version, target);
    const sumName = `${name}.sha256`;
    if (!byName.has(name) && !byName.has(sumName)) {
      continue;
    }
    const sumAsset = byName.get(sumName);
    const archiveAsset = byName.get(name);
    if (sumAsset === undefined || archiveAsset === undefined) {
      throw new SelectError(`${repo}@${best.tag_name}: missing ${sumName}`);
    }
    // oxlint-disable-next-line no-await-in-loop
    const text = await shaFileText(best, sumName);
    const hash = parseShaFile(text.trimEnd(), name);
    const { digest } = archiveAsset;
    if (digest !== undefined && digest !== `sha256:${hash}`) {
      throw new SelectError(
        `${repo}@${best.tag_name}: archive digest ${digest} != sha256:${hash} for ${name}`,
      );
    }
    assets[target] = hash;
  }
  const present = Object.keys(assets);
  if (present.length === 0) {
    throw new SelectError(`${repo}@${best.tag_name}: no supported-target assets`);
  }
  if (previous !== undefined && !force) {
    const missing = Object.keys(previous.assets).filter((t) => !(t in assets));
    if (missing.length > 0) {
      throw new SelectError(
        `${repo}@${best.tag_name}: target set shrank (lost ${missing.join(", ")}); rerun with force to accept`,
      );
    }
  }
  return { version, tag: best.tag_name, assets };
}
