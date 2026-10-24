// Offline, deterministic build (`bun run build`): validate catalog ↔ lock,
// render dist/. Any mismatch fails before dist/ is touched.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseCatalog, parseReleases } from "./catalog.ts";
import type { Catalog, Releases } from "./catalog.ts";
import {
  assertAscii,
  renderIndexPs1,
  renderIndexSh,
  renderPs1,
  renderSh,
  substitute,
} from "./render.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");

function sha256file(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fail(msg: string): never {
  throw new Error(msg);
}

function validate(catalog: Catalog, releases: Releases): void {
  const cKeys = Object.keys(catalog).toSorted();
  const rKeys = Object.keys(releases).toSorted();
  if (JSON.stringify(cKeys) !== JSON.stringify(rKeys)) {
    fail(`catalog/lock key mismatch: catalog=[${cKeys.join(",")}] releases=[${rKeys.join(",")}]`);
  }
  for (const key of cKeys) {
    const spec = catalog[key];
    const lock = releases[key];
    if (spec === undefined || lock === undefined) {
      fail(`${key}: missing entry`);
    }
    if (spec.installer === "repo") {
      if (lock.installer === undefined) {
        fail(`${key}: installer "repo" but lock has no installer hashes`);
      }
      const sh = sha256file(join(ROOT, "tools", key, "install.sh"));
      const ps1 = sha256file(join(ROOT, "tools", key, "install.ps1"));
      if (sh !== lock.installer.sh) {
        fail(`${key}: tools/${key}/install.sh sha256 does not match the lock`);
      }
      if (ps1 !== lock.installer.ps1) {
        fail(`${key}: tools/${key}/install.ps1 sha256 does not match the lock`);
      }
    } else if (lock.installer !== undefined) {
      fail(`${key}: lock records installer hashes but installer is "template"`);
    }
  }
}

function writeOut(name: string, content: string | Uint8Array): void {
  writeFileSync(join(DIST, name), content);
}

function main(): void {
  const catalog = parseCatalog(JSON.parse(readFileSync(join(ROOT, "catalog.json"), "utf8")));
  const releases = parseReleases(JSON.parse(readFileSync(join(ROOT, "releases.json"), "utf8")));
  validate(catalog, releases);

  const tplSh = readFileSync(join(ROOT, "templates/install.sh"), "utf8");
  const tplPs1 = readFileSync(join(ROOT, "templates/install.ps1"), "utf8");
  const tplIdxSh = readFileSync(join(ROOT, "templates/index.sh"), "utf8");
  const tplIdxPs1 = readFileSync(join(ROOT, "templates/index.ps1"), "utf8");

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const redirects = ["/ /index.sh 200", "/ps /index.ps1 200"];
  for (const key of Object.keys(catalog).toSorted()) {
    const spec = catalog[key];
    const lock = releases[key];
    if (spec === undefined || lock === undefined) {
      fail(`${key}: missing entry`);
    }
    if (spec.installer === "repo") {
      writeOut(`${key}.sh`, readFileSync(join(ROOT, "tools", key, "install.sh")));
      writeOut(`${key}.ps1`, readFileSync(join(ROOT, "tools", key, "install.ps1")));
    } else {
      const sh = substitute(tplSh, renderSh(key, spec, lock));
      const ps1 = substitute(tplPs1, renderPs1(key, spec, lock));
      assertAscii(`${key}.sh`, sh);
      assertAscii(`${key}.ps1`, ps1);
      writeOut(`${key}.sh`, sh);
      writeOut(`${key}.ps1`, ps1);
    }
    redirects.push(`/${key} /${key}.sh 200`, `/${key}/ps /${key}.ps1 200`);
  }
  const idxSh = substitute(tplIdxSh, renderIndexSh(catalog, releases));
  const idxPs1 = substitute(tplIdxPs1, renderIndexPs1(catalog, releases));
  assertAscii("index.sh", idxSh);
  assertAscii("index.ps1", idxPs1);
  writeOut("index.sh", idxSh);
  writeOut("index.ps1", idxPs1);
  writeOut("_redirects", `${redirects.join("\n")}\n`);
  writeOut(
    "_headers",
    [
      "/*",
      "  Content-Type: text/plain; charset=utf-8",
      "  X-Content-Type-Options: nosniff",
      "  X-Robots-Tag: noindex",
      "  Referrer-Policy: no-referrer",
      "",
    ].join("\n"),
  );
  const files = readdirSync(DIST).toSorted();
  process.stdout.write(`dist: ${files.length} files\n`);
}

main();
