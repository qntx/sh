// --dry-run on a locked install must name the same asset the real
// install would pick: the first host candidate embedded in the script,
// not blindly the first candidate. A fake `uname` puts the host on
// glibc x86_64 Linux (no /lib/ld-musl-* on macOS or the ubuntu runner),
// where the candidate order is musl-then-gnu but nosfry locks only gnu.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

const FAKE_UNAME = `#!/bin/sh
case "$1" in
    -s) echo Linux ;;
    -m) echo x86_64 ;;
    *) /bin/uname "$@" ;;
esac
`;

function dryRun(script: string): { out: string; status: number } {
  const d = mkdtempSync(join(tmpdir(), "dryrun-"));
  try {
    const bin = join(d, "bin");
    const home = join(d, "home");
    mkdirSync(bin);
    mkdirSync(home);
    const uname = join(bin, "uname");
    writeFileSync(uname, FAKE_UNAME);
    chmodSync(uname, 0o755);
    const r = spawnSync("sh", [script, "--dry-run", "--no-modify-path"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: home },
    });
    return { out: `${r.stdout}${r.stderr}`, status: r.status ?? -1 };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe("locked --dry-run asset selection", () => {
  test("nosfry picks the locked gnu target, not the musl candidate", () => {
    const { out, status } = dryRun("dist/nosfry.sh");
    expect(status).toBe(0);
    expect(out).toContain("nosfry-");
    expect(out).toContain("-x86_64-unknown-linux-gnu.tar.gz");
    expect(out).not.toContain("musl");
  });

  test("kobe picks musl, the first candidate it locks", () => {
    const { out, status } = dryRun("dist/kobe.sh");
    expect(status).toBe(0);
    expect(out).toContain("kobe-");
    expect(out).toContain("-x86_64-unknown-linux-musl.tar.gz");
    expect(out).not.toContain("gnu");
  });
});
