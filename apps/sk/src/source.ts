// sk sync library: resolve one source repo to its locked ref/commit and
// validated skills, and merge per-source results into the next lock.
// Pure of entrypoint side effects — safe to import from tests.

import {
  commit as getCommit,
  fileAtRef,
  listDir,
  releases as getReleases,
  repo as getRepo,
  latestStable,
  sha256Hex,
} from "@qntx/sync";
import type { Commit, DirEntry, Release, Repo } from "@qntx/sync";

import { fail } from "./lock.ts";
import type { Lock, SourceLock } from "./lock.ts";
import { validateSkill } from "./skill.ts";

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
    skills[e.name] = sha256Hex(bytes);
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

// The next lock: synced entries where a source ran, previous entries for
// sources that did not (failed or filtered out). Catalog sources are all
// represented when they have either.
export function mergeLock(
  sources: ReadonlyArray<string>,
  previous: Lock,
  results: ReadonlyArray<SourceResult>,
): Lock {
  const merged = nextLock([...sources], [...results]);
  for (const s of sources) {
    if (!(s in merged) && previous[s] !== undefined) {
      merged[s] = previous[s] ?? fail(`${s}: missing previous entry`);
    }
  }
  return merged;
}
