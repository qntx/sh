// Lock model + operations: the releases.json shape, its parser, merge,
// and change detection. The catalog is human input; the lock is machine state.

import { existsSync, readFileSync } from "node:fs";

import { isRecord } from "@qntx/sync";

import { KEY_RE, SHA256_RE, sanitizeDescription } from "./catalog.ts";
import type { Catalog } from "./catalog.ts";
import { TARGETS, VARIANT_RE, isGlibcTarget } from "./contract.ts";
import type { Selected } from "./select.ts";

export const VERSION_RE: RegExp = /^\d+\.\d+\.\d+$/;
export const GLIBC_RE: RegExp = /^\d+\.\d+$/;
const COMMIT_RE: RegExp = /^[0-9a-f]{40}$/;
const TARGET_SET = new Set<string>(TARGETS);
const ASSET_FIELDS = new Set(["sha256", "glibc"]);

function fail(msg: string): never {
  throw new Error(msg);
}

// One locked asset: its archive hash plus, on *-linux-gnu targets, the
// glibc floor sync measured in the shipped binary (absent = measured,
// no GLIBC version needs — e.g. a static binary).
export type LockAsset = { sha256: string; glibc?: string };

export type LockEntry = {
  version: string;
  tag: string;
  commit: string;
  immutable: boolean;
  description: string;
  assets: Record<string, LockAsset>;
  variants?: Record<string, Record<string, LockAsset>>;
};

export type Releases = Record<string, LockEntry>;

const LOCK_FIELDS = new Set([
  "version",
  "tag",
  "commit",
  "immutable",
  "description",
  "assets",
  "variants",
]);

export function parseLockEntry(key: string, raw: unknown): LockEntry {
  if (!isRecord(raw)) {
    fail(`releases ${key}: entry must be an object`);
  }
  for (const f of Object.keys(raw)) {
    if (!LOCK_FIELDS.has(f)) {
      fail(`releases ${key}: unknown field "${f}"`);
    }
  }
  const { version, tag, commit, immutable, description, assets, variants } = raw;
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    fail(`releases ${key}: version must match ${VERSION_RE}`);
  }
  if (typeof tag !== "string" || tag !== `v${version}`) {
    fail(`releases ${key}: tag must be "v${version}"`);
  }
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) {
    fail(`releases ${key}: commit must match ${COMMIT_RE}`);
  }
  if (typeof immutable !== "boolean") {
    fail(`releases ${key}: immutable must be a boolean`);
  }
  const desc = sanitizeDescription(key, description);
  const assetMap = parseAssetMap(key, "assets", assets);
  const entry: LockEntry = {
    version,
    tag,
    commit,
    immutable,
    description: desc,
    assets: assetMap,
  };
  if (variants !== undefined) {
    if (!isRecord(variants) || Object.keys(variants).length === 0) {
      fail(`releases ${key}: variants must be a non-empty object`);
    }
    const variantMap: Record<string, Record<string, LockAsset>> = {};
    for (const [v, inner] of Object.entries(variants)) {
      if (!VARIANT_RE.test(v)) {
        fail(`releases ${key}: variant name "${v}" must match ${VARIANT_RE}`);
      }
      variantMap[v] = parseAssetMap(key, `variants.${v}`, inner);
    }
    entry.variants = variantMap;
  }
  return entry;
}

function parseAssetMap(key: string, field: string, raw: unknown): Record<string, LockAsset> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    fail(`releases ${key}: ${field} must be a non-empty object`);
  }
  const map: Record<string, LockAsset> = {};
  for (const [t, a] of Object.entries(raw)) {
    if (!TARGET_SET.has(t)) {
      fail(`releases ${key}: unknown target "${t}"`);
    }
    if (!isRecord(a)) {
      fail(`releases ${key}: ${field} asset for "${t}" must be an object`);
    }
    for (const f of Object.keys(a)) {
      if (!ASSET_FIELDS.has(f)) {
        fail(`releases ${key}: ${field} asset for "${t}": unknown field "${f}"`);
      }
    }
    const { sha256, glibc } = a;
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
      fail(`releases ${key}: ${field} sha256 for "${t}" must match ${SHA256_RE}`);
    }
    const asset: LockAsset = { sha256 };
    if (glibc !== undefined) {
      if (!isGlibcTarget(t)) {
        fail(`releases ${key}: ${field} glibc is only allowed on *-linux-gnu targets`);
      }
      if (typeof glibc !== "string" || !GLIBC_RE.test(glibc)) {
        fail(`releases ${key}: ${field} glibc for "${t}" must match ${GLIBC_RE}`);
      }
      asset.glibc = glibc;
    }
    map[t] = asset;
  }
  return map;
}

export function parseReleases(raw: unknown): Releases {
  if (!isRecord(raw)) {
    fail("releases: root must be an object");
  }
  const releases: Releases = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!KEY_RE.test(key)) {
      fail(`releases key "${key}": must match ${KEY_RE}`);
    }
    releases[key] = parseLockEntry(key, entry);
  }
  return releases;
}

// Catalog ↔ lock consistency for the offline build: identical key sets,
// and every locked variant declared in the catalog (a declared variant
// may be absent from the lock — the locked release may predate its first
// published assets).
export function validateReleases(catalog: Catalog, releases: Releases): void {
  const cKeys = Object.keys(catalog).toSorted();
  const rKeys = Object.keys(releases).toSorted();
  if (JSON.stringify(cKeys) !== JSON.stringify(rKeys)) {
    fail(`catalog/lock key mismatch: catalog=[${cKeys.join(",")}] releases=[${rKeys.join(",")}]`);
  }
  for (const key of cKeys) {
    const declared = new Set(catalog[key]?.variants);
    for (const v of Object.keys(releases[key]?.variants ?? {})) {
      if (!declared.has(v)) {
        fail(`${key}: locked variant "${v}" is not declared in the catalog`);
      }
    }
  }
}

export function loadReleases(path: string): Releases {
  if (!existsSync(path)) {
    return {};
  }
  return parseReleases(JSON.parse(readFileSync(path, "utf8")));
}

function sortedEntries(map: Record<string, string>): string {
  return JSON.stringify(Object.entries(map).toSorted(([a], [b]) => a.localeCompare(b)));
}

// Re-verification keys on hashes alone: the glibc floor is derived from
// the same bytes, so an identical sha256 means an identical floor.
function shaMap(map: Record<string, LockAsset>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [t, a] of Object.entries(map)) {
    out[t] = a.sha256;
  }
  return out;
}

// Whether a fresh selection differs enough from the lock to re-verify
// archives: new version, or any target/hash in the asset maps (default
// and variants alike) changed — e.g. a maintainer re-uploaded an asset
// with different bytes, or a variant appeared/dropped.
export function changed(
  previous: LockEntry | undefined,
  selected: Selected,
  force: boolean,
): boolean {
  if (force || previous === undefined || previous.version !== selected.version) {
    return true;
  }
  if (sortedEntries(shaMap(previous.assets)) !== sortedEntries(selected.assets)) {
    return true;
  }
  const prevVariants = previous.variants ?? {};
  const nextVariants = selected.variants;
  if (
    JSON.stringify(Object.keys(prevVariants).toSorted()) !==
    JSON.stringify(Object.keys(nextVariants).toSorted())
  ) {
    return true;
  }
  return Object.entries(prevVariants).some(
    ([v, map]) => sortedEntries(shaMap(map)) !== sortedEntries(nextVariants[v] ?? {}),
  );
}

// The next lock contains catalog keys only: the synced entry when that tool
// ran, otherwise its previous entry (SYNC_TOOL runs) — tools dropped from
// the catalog are dropped here too.
export function mergeReleases(
  catalog: Catalog,
  previous: Releases,
  results: ReadonlyArray<{ key: string; entry: LockEntry }>,
): Releases {
  const next: Releases = {};
  for (const key of Object.keys(catalog).toSorted()) {
    const synced = results.find((r) => r.key === key);
    const e = synced?.entry ?? previous[key];
    if (e !== undefined) {
      next[key] = e;
    }
  }
  return next;
}

// SYNC_TOOL: undefined and "" (workflow_dispatch default) both mean "all".
export function pickToolKeys(keys: string[], only: string | undefined): string[] {
  return only === undefined || only === "" ? keys.toSorted() : [only];
}
