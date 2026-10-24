// Lock-file model for skills.lock.json + the sync resolution logic that
// maps a source repo to a ref/commit and a validated skill set.

import { existsSync, readFileSync } from "node:fs";

import { isRecord } from "@qntx/sync";

export type SourceLock = {
  ref: string;
  commit: string;
  skills: Record<string, string>;
};

export type Lock = Record<string, SourceLock>;

export function fail(msg: string): never {
  throw new Error(msg);
}

export function loadLock(path: string): Lock {
  if (!existsSync(path)) {
    return {};
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) {
    fail(`skills.lock.json: root must be an object`);
  }
  const out: Lock = {};
  for (const [repo, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      fail(`skills.lock.json ${repo}: entry must be an object`);
    }
    const { ref, commit, skills } = entry;
    if (typeof ref !== "string" || ref === "") {
      fail(`skills.lock.json ${repo}: ref must be a string`);
    }
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
      fail(`skills.lock.json ${repo}: commit must be a 40-hex sha`);
    }
    if (!isRecord(skills)) {
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
