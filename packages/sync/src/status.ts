// Per-subject sync outcome tracking: run a sync function per key, record
// per-key failures instead of aborting, and serialize the outcome for a
// later step (e.g. issue tracking) to consume.

import { writeFileSync } from "node:fs";

import { isRecord } from "./json.ts";

export type SyncStatus = { ok: string[]; failed: Record<string, string> };

// Run `fn` for each key sequentially. A throw records
// `failed[key] = message` and the loop continues; successful results are
// collected in a Map keyed the same way.
export async function settle<T>(
  keys: ReadonlyArray<string>,
  fn: (key: string) => Promise<T>,
): Promise<{ results: Map<string, T>; status: SyncStatus }> {
  const results = new Map<string, T>();
  const status: SyncStatus = { ok: [], failed: {} };
  /* oxlint-disable no-await-in-loop */
  for (const key of keys) {
    try {
      results.set(key, await fn(key));
      status.ok.push(key);
    } catch (error) {
      status.failed[key] = error instanceof Error ? error.message : String(error);
    }
  }
  /* oxlint-enable no-await-in-loop */
  return { results, status };
}

// Serialize the status as JSON (sorted ok list, sorted failed keys,
// trailing newline) when `path` is set; a missing path is a no-op so the
// status file is opt-in via the environment.
export function writeStatus(path: string | undefined, status: SyncStatus): void {
  if (path === undefined || path === "") {
    return;
  }
  const failed: Record<string, string> = {};
  for (const k of Object.keys(status.failed).toSorted()) {
    failed[k] = status.failed[k] ?? "";
  }
  const out = `${JSON.stringify({ ok: status.ok.toSorted(), failed }, null, 2)}\n`;
  writeFileSync(path, out);
}

// Strict inverse of the writeStatus shape; throws on anything else.
export function parseStatus(raw: unknown): SyncStatus {
  if (!isRecord(raw)) {
    throw new Error("status: root must be an object");
  }
  for (const f of Object.keys(raw)) {
    if (f !== "ok" && f !== "failed") {
      throw new Error(`status: unknown field "${f}"`);
    }
  }
  const { ok, failed } = raw;
  if (!Array.isArray(ok) || !ok.every((k): k is string => typeof k === "string")) {
    throw new Error("status: ok must be a string array");
  }
  if (!isRecord(failed)) {
    throw new Error("status: failed must be an object");
  }
  const failedMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(failed)) {
    if (typeof v !== "string") {
      throw new TypeError(`status: failed["${k}"] must be a string`);
    }
    failedMap[k] = v;
  }
  return { ok: [...ok], failed: failedMap };
}
