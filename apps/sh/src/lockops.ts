// Pure lock-file operations extracted for unit testing.

import { existsSync, readFileSync } from "node:fs";

import { parseReleases } from "./catalog.ts";
import type { Catalog, LockEntry, Releases } from "./catalog.ts";
import type { Selected } from "./select.ts";

// Missing lock → empty start; a present-but-invalid lock is a hard failure —
// silently resetting it would bypass the shrink check.
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
