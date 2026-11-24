// Sync task (`bun run sync`): resolve each catalog tool's newest stable
// release, verify assets, and rewrite releases.json. The default build
// and every catalog-declared variant are locked; undeclared variants are
// skipped with a summary line and `.cdx.json` SBOM sidecars are parsed
// but never fetched. Atomic per tool: a failed tool keeps its previous
// lock entry while every other tool syncs and is written.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  commit as getCommit,
  download,
  releases as getReleases,
  repo as getRepo,
  settle,
  text,
  writeIfChanged,
  writeStatus,
} from "@qntx/sync";
import type { SyncStatus } from "@qntx/sync";

import { parseCatalog, sanitizeDescription } from "./catalog.ts";
import type { ToolSpec } from "./catalog.ts";
import { archiveExt } from "./contract.ts";
import { inspectTar, inspectZip } from "./inspect.ts";
import type { LockEntry } from "./lock.ts";
import { changed, loadReleases, mergeReleases, pickToolKeys } from "./lock.ts";
import { assetName, selectRelease } from "./select.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function fail(tool: string, msg: string): never {
  throw new Error(`${tool}: ${msg}`);
}

type ToolResult = {
  key: string;
  entry: LockEntry;
  note: string;
  skipped: string[];
  unpublished: string[];
};

async function syncTool(
  key: string,
  spec: ToolSpec,
  previous: LockEntry | undefined,
  force: boolean,
  work: string,
): Promise<ToolResult> {
  const repo = await getRepo(spec.repo);
  if (repo.full_name !== spec.repo) {
    fail(key, `repo renamed: ${spec.repo} -> ${repo.full_name}`);
  }
  if (repo.private) {
    fail(key, `repo ${spec.repo} is private`);
  }
  if (repo.archived) {
    fail(key, `repo ${spec.repo} is archived`);
  }
  const description = sanitizeDescription(key, repo.description ?? "");

  const all = await getReleases(spec.repo);
  const selected = await selectRelease(
    spec.repo,
    key,
    all,
    previous,
    force,
    spec.variants ?? [],
    async (release, name) => {
      const asset = release.assets.find((a) => a.name === name);
      if (asset === undefined) {
        fail(key, `asset vanished: ${name}`);
      }
      return text(asset.browser_download_url);
    },
  );

  const latest = all.find((r) => r.tag_name === selected.tag);
  const immutable = latest?.immutable === true;
  const commit = await getCommit(spec.repo, selected.tag);

  const didChange = changed(previous, selected, force);

  const entry: LockEntry = {
    version: selected.version,
    tag: selected.tag,
    commit: commit.sha,
    immutable,
    description,
    assets: selected.assets,
  };
  if (Object.keys(selected.variants).length > 0) {
    entry.variants = selected.variants;
  }

  if (didChange) {
    const locked: Array<[string | undefined, Record<string, string>]> = [
      [undefined, selected.assets],
      ...Object.entries(selected.variants),
    ];
    /* oxlint-disable no-await-in-loop */
    for (const [variant, map] of locked) {
      for (const [target, hash] of Object.entries(map)) {
        const name = assetName(key, selected.version, target, variant);
        const url = `https://github.com/${spec.repo}/releases/download/${selected.tag}/${name}`;
        const dest = join(work, name);
        await download(url, dest);
        const got = sha256(new Uint8Array(readFileSync(dest)));
        if (got !== hash) {
          fail(key, `archive hash mismatch for ${name}: got ${got}, expected ${hash}`);
        }
        if (archiveExt(target) === "zip") {
          inspectZip(key, key, name, target, dest);
        } else {
          inspectTar(key, key, name, target, dest);
        }
      }
    }
    /* oxlint-enable no-await-in-loop */
  }

  const note = didChange
    ? `${key} ${previous?.version ?? "—"} -> ${selected.version}${force ? " (force)" : ""}`
    : `${key} ${selected.version} unchanged`;
  return { key, entry, note, skipped: selected.skipped, unpublished: selected.unpublished };
}

async function main(): Promise<number> {
  const catalog = parseCatalog(JSON.parse(readFileSync(join(ROOT, "catalog.json"), "utf8")));
  const lockPath = join(ROOT, "releases.json");
  const releases = loadReleases(lockPath);

  // GitHub passes "" for unset workflow_dispatch inputs and on schedule:
  // empty means "all tools".
  const only = process.env["SYNC_TOOL"];
  const force = process.env["SYNC_FORCE"] === "true";
  const keys = Object.keys(catalog).toSorted();
  if (only !== undefined && only !== "" && !(only in catalog)) {
    throw new Error(`SYNC_TOOL="${only}" is not in the catalog`);
  }
  const todo = pickToolKeys(keys, only);

  const work = mkdtempSync(join(tmpdir(), "sh-sync-"));
  const summary: string[] = [];
  let settled: { results: Map<string, ToolResult>; status: SyncStatus };
  try {
    settled = await settle(todo, async (key) => {
      try {
        const spec = catalog[key];
        if (spec === undefined) {
          fail(key, "not in catalog");
        }
        const result = await syncTool(key, spec, releases[key], force, work);
        summary.push(`- ${result.note}`);
        for (const v of result.skipped) {
          summary.push(`- ${key}: skipped undeclared variant ${v}`);
        }
        for (const v of result.unpublished) {
          summary.push(`- ${key}: declared variant ${v} not published in ${result.entry.tag}`);
        }
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        summary.push(`- ${key}: FAILED — ${msg}`);
        throw error;
      }
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const { results, status } = settled;

  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryFile !== undefined && summaryFile !== "") {
    appendFileSync(summaryFile, `## sh sync\n\n${summary.join("\n")}\n`);
  }
  for (const line of summary) {
    process.stdout.write(`${line.slice(2)}\n`);
  }
  for (const [key, msg] of Object.entries(status.failed)) {
    process.stderr.write(`error: ${key}: ${msg}\n`);
  }

  // Failed tools keep their previous entries; the lock reflects every
  // tool that synced.
  const next = mergeReleases(catalog, releases, [...results.values()]);
  mkdirSync(dirname(lockPath), { recursive: true });
  const out = `${JSON.stringify(next, null, 2)}\n`;
  if (writeIfChanged(lockPath, out)) {
    process.stdout.write("releases.json updated\n");
  } else {
    process.stdout.write("releases.json unchanged\n");
  }
  writeStatus(process.env["SYNC_STATUS"], status);
  return Object.keys(status.failed).length > 0 ? 1 : 0;
}

process.exitCode = await main();
