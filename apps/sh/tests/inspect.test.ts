// Unit tests for the archive layout rule shared by sync and the
// installers: the binary sits at ./<bin> (flat) or <stem>/<bin> (a single
// top-level directory named after the archive minus its extension) —
// exactly one of the two. Tiny fixtures are built with the system
// tar/zip at test time.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { inspectTar, inspectZip } from "../src/inspect.ts";

const TAR_NAME = "x-1.0.0-aarch64-apple-darwin.tar.gz";
const TAR_STEM = "x-1.0.0-aarch64-apple-darwin";
const ZIP_NAME = "x-1.0.0-x86_64-pc-windows-msvc.zip";
const ZIP_STEM = "x-1.0.0-x86_64-pc-windows-msvc";

function put(dir: string, rel: string, mode = 0o755): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "binary\n");
  chmodSync(p, mode);
}

function tgz(dir: string, members: string[]): string {
  const file = `${dir}.tar.gz`;
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("tar", ["-czf", file, "-C", dir, ...members]);
  expect(r.status).toBe(0);
  return file;
}

function zipf(dir: string, members: string[]): string {
  const file = `${dir}.zip`;
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("zip", ["-q", file, ...members], { cwd: dir });
  expect(r.status).toBe(0);
  return file;
}

function work(): string {
  return mkdtempSync(join(tmpdir(), "inspect-"));
}

describe("inspectTar", () => {
  test("flat ./<bin> is accepted", () => {
    const d = join(work(), "src");
    put(d, "x");
    expect(() =>
      inspectTar("x", "x", TAR_NAME, "aarch64-apple-darwin", tgz(d, ["./x"])),
    ).not.toThrow();
  });

  test("nested <stem>/<bin> is accepted", () => {
    const d = join(work(), "src");
    put(d, `${TAR_STEM}/x`);
    expect(() =>
      inspectTar("x", "x", TAR_NAME, "aarch64-apple-darwin", tgz(d, [TAR_STEM])),
    ).not.toThrow();
  });

  test("both layouts fail as ambiguous", () => {
    const d = join(work(), "src");
    put(d, "x");
    put(d, `${TAR_STEM}/x`);
    expect(() =>
      inspectTar("x", "x", TAR_NAME, "aarch64-apple-darwin", tgz(d, ["./x", TAR_STEM])),
    ).toThrow(/ambiguous layout/);
  });

  test("no binary fails naming both paths", () => {
    const d = join(work(), "src");
    put(d, "README");
    expect(() =>
      inspectTar("x", "x", TAR_NAME, "aarch64-apple-darwin", tgz(d, ["README"])),
    ).toThrow(/has no executable \.\/x or x-1\.0\.0-aarch64-apple-darwin\/x/);
  });

  test("a non-executable ./<bin> does not count", () => {
    const d = join(work(), "src");
    put(d, "x", 0o644);
    expect(() => inspectTar("x", "x", TAR_NAME, "aarch64-apple-darwin", tgz(d, ["./x"]))).toThrow(
      /has no executable/,
    );
  });

  test("link entries fail", () => {
    const d = join(work(), "src");
    put(d, "x");
    symlinkSync("x", join(d, "link"));
    expect(() =>
      inspectTar("x", "x", TAR_NAME, "aarch64-apple-darwin", tgz(d, ["./x", "link"])),
    ).toThrow(/link entry/);
  });
});

describe("inspectZip", () => {
  test("flat <bin>.exe is accepted", () => {
    const d = join(work(), "src");
    put(d, "x.exe");
    expect(() =>
      inspectZip("x", "x", ZIP_NAME, "x86_64-pc-windows-msvc", zipf(d, ["x.exe"])),
    ).not.toThrow();
  });

  test("nested <stem>/<bin>.exe is accepted", () => {
    const d = join(work(), "src");
    put(d, `${ZIP_STEM}/x.exe`);
    expect(() =>
      inspectZip("x", "x", ZIP_NAME, "x86_64-pc-windows-msvc", zipf(d, [`${ZIP_STEM}/x.exe`])),
    ).not.toThrow();
  });

  test("both layouts fail as ambiguous", () => {
    const d = join(work(), "src");
    put(d, "x.exe");
    put(d, `${ZIP_STEM}/x.exe`);
    expect(() =>
      inspectZip(
        "x",
        "x",
        ZIP_NAME,
        "x86_64-pc-windows-msvc",
        zipf(d, ["x.exe", `${ZIP_STEM}/x.exe`]),
      ),
    ).toThrow(/ambiguous layout/);
  });

  test("no binary fails naming both paths", () => {
    const d = join(work(), "src");
    put(d, "README");
    expect(() =>
      inspectZip("x", "x", ZIP_NAME, "x86_64-pc-windows-msvc", zipf(d, ["README"])),
    ).toThrow(/has no x\.exe or x-1\.0\.0-x86_64-pc-windows-msvc\/x\.exe/);
  });
});
