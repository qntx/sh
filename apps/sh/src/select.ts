// Pure release selection: pick the newest stable vX.Y.Z tag and validate
// its asset set. No network — unit tests drive this with recorded fixtures.

import { STABLE_TAG_RE, latestStable } from "@qntx/sync";
import type { Release } from "@qntx/sync";

import { SHA256_RE, TARGETS } from "./catalog.ts";
import type { Target } from "./catalog.ts";
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

// Asset grammar: `<bin>-<version>[-<variant>]-<target>.<ext>` where <ext>
// is `zip` on Windows targets and `tar.gz` elsewhere, plus the sidecars
// `<archive>.sha256` and `<stem>.cdx.json` (SBOM, never fetched). A
// <variant> is a lowercase alnum segment (`onion`); names not starting
// with `<bin>-<version>-` are outside our namespace entirely.
const VARIANT_RE: RegExp = /^[a-z][a-z0-9]*$/;

export type AssetKind = "archive" | "sha256" | "sbom";
export type ParsedAsset = { variant: string | undefined; target: Target; kind: AssetKind };

// Parse one release asset name. Returns undefined outside the
// `<bin>-<version>-` namespace; throws when inside it but unparseable —
// that is naming drift and must fail loudly instead of silently dropping
// a platform.
export function parseAssetName(
  bin: string,
  version: string,
  name: string,
): ParsedAsset | undefined {
  const prefix = `${bin}-${version}-`;
  if (!name.startsWith(prefix)) {
    return undefined;
  }
  const rest = name.slice(prefix.length);
  const matches: ParsedAsset[] = [];
  for (const target of TARGETS) {
    const ext = isWindows(target) ? "zip" : "tar.gz";
    const suffixes: ReadonlyArray<readonly [string, AssetKind]> = [
      [`${target}.${ext}`, "archive"],
      [`${target}.${ext}.sha256`, "sha256"],
      [`${target}.cdx.json`, "sbom"],
    ];
    for (const [suffix, kind] of suffixes) {
      let variant: string | undefined;
      if (rest === suffix) {
        variant = undefined;
      } else if (rest.endsWith(`-${suffix}`)) {
        const v = rest.slice(0, rest.length - suffix.length - 1);
        if (!VARIANT_RE.test(v)) {
          continue;
        }
        variant = v;
      } else {
        continue;
      }
      matches.push({ variant, target, kind });
    }
  }
  if (matches.length === 0) {
    throw new SelectError(`unrecognized asset ${name}`);
  }
  if (matches.length > 1) {
    throw new SelectError(`ambiguous asset ${name}`);
  }
  return matches[0];
}

export type Selected = {
  version: string;
  tag: string;
  assets: Record<string, string>;
  skipped: string[];
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
  // Parse every asset first. Any asset inside our namespace
  // (<bin>-<version>-*) that does not parse is naming drift — fail loudly
  // instead of silently dropping a platform (as happened to
  // x86_64-pc-windows-msvc). Assets of undeclared variants parse fine and
  // are skipped: not fetched, not checked.
  const parsed = new Map<string, ParsedAsset>();
  for (const a of best.assets) {
    let p: ParsedAsset | undefined;
    try {
      p = parseAssetName(bin, version, a.name);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new SelectError(`${repo}@${best.tag_name}: ${msg}`);
    }
    if (p !== undefined) {
      parsed.set(a.name, p);
    }
  }
  const skipped = [
    ...new Set(
      [...parsed.values()].map((p) => p.variant).filter((v): v is string => v !== undefined),
    ),
  ].toSorted();

  const assets: Record<string, string> = {};
  for (const target of TARGETS) {
    const name = assetName(bin, version, target);
    const sumName = `${name}.sha256`;
    const sbomName = `${bin}-${version}-${target}.cdx.json`;
    if (!byName.has(name)) {
      if (byName.has(sbomName)) {
        throw new SelectError(`${repo}@${best.tag_name}: ${sbomName} has no archive`);
      }
      if (byName.has(sumName)) {
        throw new SelectError(`${repo}@${best.tag_name}: missing ${sumName}`);
      }
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
  return { version, tag: best.tag_name, assets, skipped };
}
