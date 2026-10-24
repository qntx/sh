// Lock model + operations: the releases.json shape, its parser, merge,
// and change detection. The catalog is human input; the lock is machine state.

import { existsSync, readFileSync } from "node:fs";

import { isRecord } from "@qntx/sync";

import { KEY_RE, SHA256_RE, TARGETS, sanitizeDescription } from "./catalog.ts";
import type { Catalog } from "./catalog.ts";
import type { Selected } from "./select.ts";

export const VERSION_RE: RegExp = /^\d+\.\d+\.\d+$/;
const COMMIT_RE: RegExp = /^[0-9a-f]{40}$/;
const TARGET_SET = new Set<string>(TARGETS);

function fail(msg: string): never {
  throw new Error(msg);
}

export type LockEntry = {
  version: string;
  tag: string;
  commit: string;
  immutable: boolean;
  description: string;
  assets: Record<string, string>;
};

export type Releases = Record<string, LockEntry>;

const LOCK_FIELDS = new Set(["version", "tag", "commit", "immutable", "description", "assets"]);

export function parseLockEntry(key: string, raw: unknown): LockEntry {
  if (!isRecord(raw)) {
    fail(`releases ${key}: entry must be an object`);
  }
  for (const f of Object.keys(raw)) {
    if (!LOCK_FIELDS.has(f)) {
      fail(`releases ${key}: unknown field "${f}"`);
    }
  }
  const { version, tag, commit, immutable, description, assets } = raw;
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
  if (!isRecord(assets) || Object.keys(assets).length === 0) {
    fail(`releases ${key}: assets must be a non-empty object`);
  }
  const assetMap: Record<string, string> = {};
  for (const [t, h] of Object.entries(assets)) {
    if (!TARGET_SET.has(t)) {
      fail(`releases ${key}: unknown target "${t}"`);
    }
    if (typeof h !== "string" || !SHA256_RE.test(h)) {
      fail(`releases ${key}: asset hash for "${t}" must match ${SHA256_RE}`);
    }
    assetMap[t] = h;
  }
  const entry: LockEntry = {
    version,
    tag,
    commit,
    immutable,
    description: desc,
    assets: assetMap,
  };
  return entry;
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

export function loadReleases(path: string): Releases {
  if (!existsSync(path)) {
    return {};
  }
  return parseReleases(JSON.parse(readFileSync(path, "utf8")));
}

// Whether a fresh selection differs enough from the lock to re-verify
// archives: new version, or any target/hash in the asset map changed
// (e.g. a maintainer re-uploaded an asset with different bytes).
export function changed(
  previous: LockEntry | undefined,
  selected: Selected,
  force: boolean,
): boolean {
  return (
    force ||
    previous === undefined ||
    previous.version !== selected.version ||
    JSON.stringify(Object.entries(previous.assets).toSorted(([a], [b]) => a.localeCompare(b))) !==
      JSON.stringify(Object.entries(selected.assets).toSorted(([a], [b]) => a.localeCompare(b)))
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
