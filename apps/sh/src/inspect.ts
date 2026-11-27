// Archive member inspection for sync verification. The contract's
// layout.members give the two legal spots: flat (`./<bin>` /
// `<bin>.exe`) or nested under a single top-level `<stem>/` directory
// (stem = archive name minus its extension). Link entries and unsafe
// paths are always rejected. The installers extract with the same rule.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { archiveExt, isGlibcTarget, layoutMembers } from "./contract.ts";
import { ElfError, glibcFloor } from "./elf.ts";

function fail(tool: string, msg: string): never {
  throw new Error(`${tool}: ${msg}`);
}

// bsdtar and GNU tar both put the entry type in column 0 and the pathname
// last; owner/group/date field counts differ between them.
const TAR_LINE_RE = /^(\S+)\s.*\s(\S+)$/;

// Validate the tar layout and return the matched binary member (flat
// "./<bin>" or nested "<stem>/<bin>").
export function inspectTar(
  tool: string,
  bin: string,
  name: string,
  target: string,
  file: string,
): string {
  const stem = name.slice(0, -".tar.gz".length);
  const [flat, nested] = layoutMembers(target, bin, stem);
  const out = spawnSync("tar", ["-tvzf", file], { encoding: "utf8" });
  if (out.status !== 0) {
    fail(tool, `tar -tvzf failed: ${(out.stderr ?? "").trim()}`);
  }
  let flatFound = false;
  let nestedFound = false;
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
    if (type === "-" && /x/i.test(meta.slice(1))) {
      if (path === flat) {
        flatFound = true;
      }
      if (path === nested) {
        nestedFound = true;
      }
    }
  }
  if (flatFound && nestedFound) {
    fail(tool, `tar has ambiguous layout: both ${flat} and ${nested}`);
  }
  if (!flatFound && !nestedFound) {
    fail(tool, `tar has no executable ${flat} or ${nested}`);
  }
  return flatFound ? flat : nested;
}

export function inspectZip(
  tool: string,
  bin: string,
  name: string,
  target: string,
  file: string,
): void {
  const stem = name.slice(0, -".zip".length);
  const [flat, nested] = layoutMembers(target, bin, stem);
  const out = spawnSync("unzip", ["-Z1", file], { encoding: "utf8" });
  if (out.status !== 0) {
    fail(tool, `unzip -Z1 failed: ${(out.stderr ?? "").trim()}`);
  }
  const names = out.stdout.split("\n").filter((n) => n !== "");
  let flatFound = false;
  let nestedFound = false;
  for (const n of names) {
    if (n.startsWith("/") || n.split("/").includes("..")) {
      fail(tool, `zip contains an unsafe path: ${n}`);
    }
    if (n === flat) {
      flatFound = true;
    }
    if (n === nested) {
      nestedFound = true;
    }
  }
  if (flatFound && nestedFound) {
    fail(tool, `zip has ambiguous layout: both ${flat} and ${nested}`);
  }
  if (!flatFound && !nestedFound) {
    fail(tool, `zip has no ${flat} or ${nested}`);
  }
}

// Verify the archive layout and measure the shipped binary's glibc floor
// on *-linux-gnu targets (the only ones that link glibc). Returns the
// lock record's extra fields; {} everywhere else.
export function inspectArchive(
  tool: string,
  bin: string,
  name: string,
  target: string,
  file: string,
  work: string,
): { glibc?: string } {
  if (archiveExt(target) === "zip") {
    inspectZip(tool, bin, name, target, file);
    return {};
  }
  const member = inspectTar(tool, bin, name, target, file);
  if (!isGlibcTarget(target)) {
    return {};
  }
  const dir = mkdtempSync(join(work, "elf-"));
  try {
    const out = spawnSync("tar", ["-xzf", file, "-C", dir, member], { encoding: "utf8" });
    if (out.status !== 0) {
      fail(tool, `tar -xzf ${member} failed: ${(out.stderr ?? "").trim()}`);
    }
    const buf = new Uint8Array(readFileSync(join(dir, member)));
    try {
      const glibc = glibcFloor(buf);
      return glibc === undefined ? {} : { glibc };
    } catch (error) {
      if (error instanceof ElfError) {
        fail(tool, `${name}: ${error.message}`);
      }
      throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
