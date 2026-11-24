// A user-supplied install dir that fails validation is bad arguments
// (exit 2): --install-dir, --install-dir= and <TOOL>_INSTALL_DIR all go
// through resolve_dir before any network work. A default dir derived
// from XDG_BIN_HOME/HOME failing the same checks is an environment
// failure (exit 1). Either way nothing may be created under HOME.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

function run(
  args: string[],
  env: Record<string, string> = {},
  homeName = "home",
): { out: string; status: number; left: string[] } {
  const d = mkdtempSync(join(tmpdir(), "installdir-"));
  const home = join(d, homeName);
  mkdirSync(home);
  try {
    const r = spawnSync("sh", ["dist/kobe.sh", "--no-modify-path", ...args], {
      encoding: "utf8",
      // Clear XDG so the default dir is derived from HOME deterministically.
      env: {
        ...process.env,
        XDG_BIN_HOME: "",
        XDG_CONFIG_HOME: "",
        ...env,
        HOME: home,
      },
    });
    return {
      out: `${r.stdout}${r.stderr}`,
      status: r.status ?? -1,
      left: readdirSync(home),
    };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe("invalid install dir exit code", () => {
  test("--install-dir rel exits 2 and reports the absolute-path rule", () => {
    const { out, status, left } = run(["--install-dir", "rel"]);
    expect(status).toBe(2);
    expect(out).toContain("absolute");
    expect(left).toStrictEqual([]);
  });

  test("--install-dir=<dir with space> exits 2 on unsafe characters", () => {
    const { out, status, left } = run(["--install-dir=/tmp/a b"]);
    expect(status).toBe(2);
    expect(out).toContain("unsafe");
    expect(left).toStrictEqual([]);
  });

  test("--install-dir with a .. segment exits 2", () => {
    const { status, left } = run(["--install-dir", "/tmp/x/../y"]);
    expect(status).toBe(2);
    expect(left).toStrictEqual([]);
  });

  test("KOBE_INSTALL_DIR=rel exits 2", () => {
    const { status, left } = run([], { KOBE_INSTALL_DIR: "rel" });
    expect(status).toBe(2);
    expect(left).toStrictEqual([]);
  });

  test("a default dir under a HOME containing a space exits 1", () => {
    const { status, left } = run([], {}, "home dir");
    expect(status).toBe(1);
    expect(left).toStrictEqual([]);
  });
});
