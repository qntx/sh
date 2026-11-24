// Sync task (`bun run sync`): resolve each source repo's skill set, verify
// SKILL.md bytes, and rewrite skills.lock.json + content/. Atomic: any
// failure writes nothing. The sync logic lives in source.ts so tests can
// import it without running this entrypoint.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord, lockJson, writeIfChanged } from "@qntx/sync";

import { fail, loadLock } from "./lock.ts";
import { mergeLock, realDeps, syncSource } from "./source.ts";
import type { SourceResult } from "./source.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function parseSources(path: string): string[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) {
    fail("skills.json: root must be an object");
  }
  const { sources } = raw;
  if (!Array.isArray(sources) || sources.length === 0) {
    fail("skills.json: sources must be a non-empty array");
  }
  const out: string[] = [];
  for (const s of sources) {
    if (typeof s !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
      fail(`skills.json: bad source ${JSON.stringify(s)}`);
    }
    out.push(s);
  }
  return out;
}

async function main(): Promise<number> {
  const sources = parseSources(join(ROOT, "skills.json"));
  const lockPath = join(ROOT, "skills.lock.json");
  const only = process.env["SYNC_SOURCE"];
  // Empty string (workflow_dispatch default / schedule) means all sources.
  const todo =
    only === undefined || only === ""
      ? sources
      : (() => {
          if (!sources.includes(only)) {
            fail(`SYNC_SOURCE="${only}" is not in skills.json`);
          }
          return [only];
        })();

  const previous = loadLock(lockPath);
  const results: SourceResult[] = [];
  const failures: string[] = [];
  const summary: string[] = [];
  /* oxlint-disable no-await-in-loop */
  for (const source of todo) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      const r = await syncSource(source, realDeps);
      results.push(r);
      summary.push(
        `- ${source} @ ${r.entry.ref}: ${Object.keys(r.entry.skills).toSorted().join(", ")}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`${source}: ${msg}`);
      summary.push(`- ${source}: FAILED — ${msg}`);
    }
  }
  /* oxlint-enable no-await-in-loop */

  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryFile !== undefined && summaryFile !== "") {
    appendFileSync(summaryFile, `## sk sync\n\n${summary.join("\n")}\n`);
  }
  for (const line of summary) {
    process.stdout.write(`${line.slice(2)}\n`);
  }
  for (const f of failures) {
    process.stderr.write(`error: ${f}\n`);
  }
  if (failures.length > 0) {
    return 1;
  }

  // Sources not synced this run keep their previous lock entries.
  const merged = mergeLock(sources, previous, results);
  // Skill-name uniqueness across the merged lock.
  const seen = new Set<string>();
  for (const [src, entry] of Object.entries(merged)) {
    for (const n of Object.keys(entry.skills)) {
      if (seen.has(n)) {
        fail(`${n}: locked by more than one source (${src})`);
      }
      seen.add(n);
    }
  }

  const lockedNames = new Set([...seen].toSorted());
  const contentDir = join(ROOT, "content");
  mkdirSync(contentDir, { recursive: true });
  // Write fetched skill files; entries kept from previous runs reuse the
  // bytes already on disk (they are hash-locked anyway).
  for (const r of results) {
    for (const [name, bytes] of r.files) {
      const dir = join(contentDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), bytes);
    }
  }
  // Remove content dirs no longer locked.
  for (const d of readdirSync(contentDir)) {
    if (!lockedNames.has(d)) {
      rmSync(join(contentDir, d), { recursive: true, force: true });
    }
  }

  if (writeIfChanged(lockPath, lockJson(merged))) {
    process.stdout.write("skills.lock.json updated\n");
  } else {
    process.stdout.write("skills.lock.json unchanged\n");
  }
  return 0;
}

process.exitCode = await main();
