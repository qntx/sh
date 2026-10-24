// Sync task (`bun run sync`): resolve each catalog tool's newest stable
// release, verify assets, and rewrite releases.json. Atomic: any failure
// writes nothing.

import { spawnSync } from "node:child_process";
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
  text,
  writeIfChanged,
} from "@qntx/sync";

import { parseCatalog, sanitizeDescription } from "./catalog.ts";
import type { ToolSpec } from "./catalog.ts";
import type { LockEntry } from "./lock.ts";
import { changed, loadReleases, mergeReleases, pickToolKeys } from "./lock.ts";
import { assetName, isWindows, selectRelease } from "./select.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function fail(tool: string, msg: string): never {
  throw new Error(`${tool}: ${msg}`);
}

// bsdtar and GNU tar both put the entry type in column 0 and the pathname
// last; owner/group/date field counts differ between them.
const TAR_LINE_RE = /^(\S+)\s.*\s(\S+)$/;

function inspectTar(tool: string, bin: string, file: string): void {
  const out = spawnSync("tar", ["-tvzf", file], { encoding: "utf8" });
  if (out.status !== 0) {
    fail(tool, `tar -tvzf failed: ${(out.stderr ?? "").trim()}`);
  }
  let found = false;
  for (const line of out.stdout.split("\n")) {
    if (line === "") {
      continue;
    }
    const m = TAR_LINE_RE.exec(line);
    const meta = m?.[1];
    const path = m?.[2];
    if (meta === undefined || path === undefined) {
      fail(tool, `unparseable tar entry: ${line}`);
    }
    const type = meta.charAt(0);
    if (type === "l" || type === "h") {
      fail(tool, `tar contains a link entry: ${path}`);
    }
    if (path.startsWith("/") || path.split("/").includes("..")) {
      fail(tool, `tar contains an unsafe path: ${path}`);
    }
    if (type === "-" && path === `./${bin}` && /x/i.test(meta.slice(1))) {
      found = true;
    }
  }
  if (!found) {
    fail(tool, `tar has no executable ./${bin}`);
  }
}

function inspectZip(tool: string, bin: string, file: string): void {
  const out = spawnSync("unzip", ["-Z1", file], { encoding: "utf8" });
  if (out.status !== 0) {
    fail(tool, `unzip -Z1 failed: ${(out.stderr ?? "").trim()}`);
  }
  const names = out.stdout.split("\n").filter((n) => n !== "");
  let found = false;
  for (const n of names) {
    if (n.startsWith("/") || n.split("/").includes("..")) {
      fail(tool, `zip contains an unsafe path: ${n}`);
    }
    if (n === `${bin}.exe`) {
      found = true;
    }
  }
  if (!found) {
    fail(tool, `zip has no ${bin}.exe at root`);
  }
}

type ToolResult = {
  key: string;
  entry: LockEntry;
  note: string;
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

  if (didChange) {
    /* oxlint-disable no-await-in-loop */
    for (const [target, hash] of Object.entries(selected.assets)) {
      const name = assetName(key, selected.version, target);
      const url = `https://github.com/${spec.repo}/releases/download/${selected.tag}/${name}`;
      const dest = join(work, name);
      await download(url, dest);
      const got = sha256(new Uint8Array(readFileSync(dest)));
      if (got !== hash) {
        fail(key, `archive hash mismatch for ${name}: got ${got}, expected ${hash}`);
      }
      if (isWindows(target)) {
        inspectZip(key, key, dest);
      } else {
        inspectTar(key, key, dest);
      }
    }
    /* oxlint-enable no-await-in-loop */
  }

  const note = didChange
    ? `${key} ${previous?.version ?? "—"} -> ${selected.version}${force ? " (force)" : ""}`
    : `${key} ${selected.version} unchanged`;
  return { key, entry, note };
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
  const results: ToolResult[] = [];
  const failures: string[] = [];
  const summary: string[] = [];
  try {
    /* oxlint-disable no-await-in-loop */
    for (const key of todo) {
      try {
        const spec = catalog[key];
        if (spec === undefined) {
          fail(key, "not in catalog");
        }
        // oxlint-disable-next-line no-await-in-loop
        const result = await syncTool(key, spec, releases[key], force, work);
        results.push(result);
        summary.push(`- ${result.note}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        failures.push(`${key}: ${msg}`);
        summary.push(`- ${key}: FAILED — ${msg}`);
      }
    }
    /* oxlint-enable no-await-in-loop */
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryFile !== undefined && summaryFile !== "") {
    appendFileSync(summaryFile, `## sh sync\n\n${summary.join("\n")}\n`);
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

  const next = mergeReleases(catalog, releases, results);
  mkdirSync(dirname(lockPath), { recursive: true });
  const out = `${JSON.stringify(next, null, 2)}\n`;
  if (writeIfChanged(lockPath, out)) {
    process.stdout.write("releases.json updated\n");
  } else {
    process.stdout.write("releases.json unchanged\n");
  }
  return 0;
}

process.exitCode = await main();
