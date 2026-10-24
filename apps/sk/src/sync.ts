// Sync task (`bun run sync`): resolve each source repo's skill set, verify
// SKILL.md bytes, and rewrite skills.lock.json + content/. Atomic: any
// failure writes nothing.

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

import {
  commit as getCommit,
  fileAtRef,
  listDir,
  lockJson,
  releases as getReleases,
  repo as getRepo,
  writeIfChanged,
  latestStable,
} from "@qntx/github";
import type { Commit, DirEntry, Release, Repo } from "@qntx/github";

import { fail, isObj, loadLock, sha256hex } from "./select.ts";
import type { Lock, SourceLock } from "./select.ts";
import { validateSkill } from "./skill.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS_DIR = "skills";

// GitHub API surface, injectable for unit tests.
// Sync-returning implementations are allowed so tests can stay sync.
export type Deps = {
  repo: (name: string) => Promise<Repo> | Repo;
  releases: (name: string) => Promise<Release[]> | Release[];
  commit: (name: string, ref: string) => Promise<Commit> | Commit;
  listDir: (name: string, path: string, ref: string) => Promise<DirEntry[]> | DirEntry[];
  fileAtRef: (
    name: string,
    path: string,
    ref: string,
  ) => Promise<Uint8Array | undefined> | Uint8Array;
};

// The default-branch commit SHA used as ref when no stable tag exists.
async function headSha(source: string, repo: Repo, deps: Deps): Promise<string> {
  const head = await deps.commit(source, repo.default_branch);
  return head.sha;
}

export const realDeps: Deps = {
  repo: getRepo,
  releases: getReleases,
  commit: getCommit,
  listDir,
  fileAtRef,
};

export type SourceResult = {
  source: string;
  entry: SourceLock;
  files: Map<string, Uint8Array>;
};

// Resolve one source repo to its locked ref/commit and validated skills.
export async function syncSource(source: string, deps: Deps): Promise<SourceResult> {
  const repo = await deps.repo(source);
  if (repo.full_name !== source) {
    fail(`${source}: repo renamed to ${repo.full_name}`);
  }
  if (repo.private) {
    fail(`${source}: repo is private`);
  }
  if (repo.archived) {
    fail(`${source}: repo is archived`);
  }

  // Ref: newest stable vX.Y.Z tag, else the default branch's commit SHA.
  const stable = latestStable(await deps.releases(source));
  const ref = stable?.tag_name ?? (await headSha(source, repo, deps));
  const commit = await deps.commit(source, ref);

  const entries = await deps.listDir(source, SKILLS_DIR, ref);
  const skills: Record<string, string> = {};
  const files = new Map<string, Uint8Array>();
  /* oxlint-disable no-await-in-loop */
  for (const e of entries) {
    if (e.type !== "dir") {
      fail(`${source}: skills/${e.name} is not a directory`);
    }
    const inner = await deps.listDir(source, e.path, ref);
    const names = inner.map((i) => i.name).toSorted();
    const [only] = names;
    if (inner.length !== 1 || only !== "SKILL.md") {
      fail(`${source}: ${e.path} must contain exactly one file SKILL.md, got [${names.join(",")}]`);
    }
    const bytes = await deps.fileAtRef(source, `${e.path}/SKILL.md`, ref);
    if (bytes === undefined) {
      fail(`${source}: ${e.path}/SKILL.md missing`);
    }
    const skill = validateSkill(e.name, bytes);
    if (skill.fm.name in skills || e.name in skills) {
      fail(`${source}: duplicate skill name ${e.name}`);
    }
    skills[e.name] = sha256hex(bytes);
    files.set(e.name, bytes);
  }
  /* oxlint-enable no-await-in-loop */
  if (Object.keys(skills).length === 0) {
    fail(`${source}: no skills found in ${SKILLS_DIR}/`);
  }
  return { source, entry: { ref, commit: commit.sha, skills }, files };
}

// Merge synced results into the next lock, keyed by source (sorted later
// by lockJson). Sources removed from skills.json are dropped.
export function nextLock(sources: string[], results: SourceResult[]): Lock {
  const bySource = new Map(results.map((r) => [r.source, r.entry]));
  const out: Lock = {};
  for (const s of sources) {
    const e = bySource.get(s);
    if (e !== undefined) {
      out[s] = e;
    }
  }
  return out;
}

function parseSources(path: string): string[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isObj(raw)) {
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
  const merged = nextLock(sources, results);
  for (const s of sources) {
    if (!(s in merged) && previous[s] !== undefined) {
      merged[s] = previous[s] ?? fail(`${s}: missing previous entry`);
    }
  }
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
