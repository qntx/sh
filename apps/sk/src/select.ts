// Lock-file model for skills.lock.json + the sync resolution logic that
// maps a source repo to a ref/commit and a validated skill set.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export type SourceLock = {
  ref: string;
  commit: string;
  skills: Record<string, string>;
};

export type Lock = Record<string, SourceLock>;

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function fail(msg: string): never {
  throw new Error(msg);
}

export function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadLock(path: string): Lock {
  if (!existsSync(path)) {
    return {};
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isObj(raw)) {
    fail(`skills.lock.json: root must be an object`);
  }
  const out: Lock = {};
  for (const [repo, entry] of Object.entries(raw)) {
    if (!isObj(entry)) {
      fail(`skills.lock.json ${repo}: entry must be an object`);
    }
    const { ref, commit, skills } = entry;
    if (typeof ref !== "string" || ref === "") {
      fail(`skills.lock.json ${repo}: ref must be a string`);
    }
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
      fail(`skills.lock.json ${repo}: commit must be a 40-hex sha`);
    }
    if (typeof skills !== "object" || skills === null || Array.isArray(skills)) {
      fail(`skills.lock.json ${repo}: skills must be an object`);
    }
    const map: Record<string, string> = {};
    for (const [n, h] of Object.entries(skills)) {
      if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) {
        fail(`skills.lock.json ${repo}.skills.${n}: must be a 64-hex sha256`);
      }
      map[n] = h;
    }
    out[repo] = { ref, commit, skills: map };
  }
  return out;
}
