// Deterministic lock-file I/O: sorted keys, 2-space JSON, trailing newline.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/// Serialize a map with sorted keys, 2-space indent, trailing newline.
export function lockJson(entries: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(entries).toSorted()) {
    const e = entries[k];
    if (e !== undefined) {
      sorted[k] = e;
    }
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/// Write `text` to `path` only when the content differs.
export function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) {
    return false;
  }
  writeFileSync(path, text);
  return true;
}
