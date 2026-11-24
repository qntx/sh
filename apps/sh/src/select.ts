// Pure release selection: pick the newest stable vX.Y.Z tag and validate
// its asset set. No network — unit tests drive this with recorded fixtures.

import { STABLE_TAG_RE, latestStable } from "@qntx/sync";
import type { Release } from "@qntx/sync";

import { SHA256_RE } from "./catalog.ts";
import { TARGETS, VARIANT_RE, archiveExt } from "./contract.ts";
import type { LockEntry } from "./lock.ts";

export class SelectError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SelectError";
  }
}

export function assetName(bin: string, version: string, target: string, variant?: string): string {
  const v = variant === undefined ? "" : `-${variant}`;
  return `${bin}-${version}${v}-${target}.${archiveExt(target)}`;
}

// Asset grammar (contract/release-assets.json):
// `<bin>-<version>[-<variant>]-<target>.<ext>` where <ext> is the
// target's archive extension, plus the sidecars `<archive>.sha256` and
// `<stem>.cdx.json` (SBOM, never fetched). A <variant> matches
// VARIANT_RE (`onion`); names not starting with `<bin>-<version>-` are
// outside our namespace entirely.

export type AssetKind = "archive" | "sha256" | "sbom";
export type ParsedAsset = { variant: string | undefined; target: string; kind: AssetKind };

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
    const ext = archiveExt(target);
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
  variants: Record<string, Record<string, string>>;
  skipped: string[];
  unpublished: string[];
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
  declared: ReadonlyArray<string>,
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
  const declaredSet = new Set(declared);
  const skipped = [
    ...new Set(
      [...parsed.values()]
        .map((p) => p.variant)
        .filter((v): v is string => v !== undefined && !declaredSet.has(v)),
    ),
  ].toSorted();
  // A declared variant with no assets at all is "not published in this
  // release" — reported, not an error (the locked release may predate it).
  const published = new Set(
    [...parsed.values()].map((p) => p.variant).filter((v): v is string => v !== undefined),
  );
  const unpublished = declared.filter((v) => !published.has(v));

  // The pairing rules (archive ⇔ .sha256, digest cross-check, orphan
  // .cdx.json) are identical for the default build and every declared
  // variant; "no supported-target assets" applies to the default only.
  const assets: Record<string, string> = {};
  const variants: Record<string, Record<string, string>> = {};
  /* oxlint-disable no-await-in-loop */
  for (const variant of [undefined, ...declared]) {
    if (variant !== undefined && unpublished.includes(variant)) {
      continue;
    }
    const out = variant === undefined ? assets : (variants[variant] ??= {});
    for (const target of TARGETS) {
      const name = assetName(bin, version, target, variant);
      const sumName = `${name}.sha256`;
      const v = variant === undefined ? "" : `-${variant}`;
      const sbomName = `${bin}-${version}${v}-${target}.cdx.json`;
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
      const text = await shaFileText(best, sumName);
      const hash = parseShaFile(text.trimEnd(), name);
      const { digest } = archiveAsset;
      if (digest !== undefined && digest !== `sha256:${hash}`) {
        throw new SelectError(
          `${repo}@${best.tag_name}: archive digest ${digest} != sha256:${hash} for ${name}`,
        );
      }
      out[target] = hash;
    }
  }
  /* oxlint-enable no-await-in-loop */

  if (Object.keys(assets).length === 0) {
    throw new SelectError(`${repo}@${best.tag_name}: no supported-target assets`);
  }
  if (previous !== undefined && !force) {
    const missing = Object.keys(previous.assets).filter((t) => !(t in assets));
    for (const [v, map] of Object.entries(previous.variants ?? {})) {
      const now = variants[v] ?? {};
      missing.push(
        ...Object.keys(map)
          .filter((t) => !(t in now))
          .map((t) => `${v}/${t}`),
      );
    }
    if (missing.length > 0) {
      throw new SelectError(
        `${repo}@${best.tag_name}: target set shrank (lost ${missing.join(", ")}); rerun with force to accept`,
      );
    }
  }
  return { version, tag: best.tag_name, assets, variants, skipped, unpublished };
}
