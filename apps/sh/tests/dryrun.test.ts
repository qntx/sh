// --dry-run on a locked install must name the same asset the real
// install would pick: the first host candidate embedded in the script,
// not blindly the first candidate. A fake `uname` puts the host on
// glibc x86_64 Linux (no /lib/ld-musl-* on macOS or the ubuntu runner),
// where the candidate order is musl-then-gnu but nosfry locks only gnu.
// Configurable getconf/ldd stubs drive the host glibc the installer sees
// — both are always stubbed so the real host can never leak in.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const FAKE_UNAME = `#!/bin/sh
case "$1" in
    -s) echo Linux ;;
    -m) echo x86_64 ;;
    *) /bin/uname "$@" ;;
esac
`;

// glibc: print "glibc <v>" for GNU_LIBC_VERSION; undefined -> exit 1.
// ldd: print a first --version line; undefined -> exit 1.
type Host = { glibc?: string | undefined; ldd?: string | undefined };

const lock = JSON.parse(
  readFileSync(fileURLToPath(new URL("../releases.json", import.meta.url)), "utf8"),
) as Record<
  string,
  { version: string; assets: Record<string, { sha256: string; glibc?: string }> }
>;
const NOSFRY_V = lock["nosfry"]?.version ?? "";
const F = lock["nosfry"]?.assets["x86_64-unknown-linux-gnu"]?.glibc;
const KOBE_V = lock["kobe"]?.version ?? "";

const HOST_ABOVE: Host = { glibc: "99.0" };

// A host version equal to `floor` as a decimal but strictly older when
// the minor is compared numerically ("2.3" == "2.30" as decimals, but
// minor 3 < 30).
function lexicallyAbove(floor: string): string {
  const [maj = "0", min = "0"] = floor.split(".");
  return `${maj}.${Math.floor(Number(min) / 10)}`;
}
const LEX_TRAP = F === undefined ? "0.0" : lexicallyAbove(F);
const F_MINOR = Number((F ?? "0.0").split(".")[1]);

function stub(host: Host): string[] {
  const getconf = `#!/bin/sh
${
  host.glibc === undefined
    ? "exit 1\n"
    : `[ "$1" = GNU_LIBC_VERSION ] && echo 'glibc ${host.glibc}' || exit 1\n`
}`;
  const ldd = `#!/bin/sh
${host.ldd === undefined ? "exit 1\n" : `echo '${host.ldd}'\n`}`;
  return [getconf, ldd];
}

function dryRun(
  script: string,
  host: Host = HOST_ABOVE,
  args: string[] = [],
): { out: string; status: number } {
  const d = mkdtempSync(join(tmpdir(), "dryrun-"));
  try {
    const bin = join(d, "bin");
    const home = join(d, "home");
    mkdirSync(bin);
    mkdirSync(home);
    const files: Record<string, string> = { uname: FAKE_UNAME };
    const [getconf = "", ldd = ""] = stub(host);
    files["getconf"] = getconf;
    files["ldd"] = ldd;
    for (const [name, content] of Object.entries(files)) {
      const p = join(bin, name);
      writeFileSync(p, content);
      chmodSync(p, 0o755);
    }
    const r = spawnSync("sh", [script, ...args, "--dry-run", "--no-modify-path"], {
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

describe("glibc floor", () => {
  test("nosfry locks a gnu floor", () => {
    expect(F).toMatch(/^\d+\.\d+$/);
  });

  test("host glibc below the floor exits 3 with the precise message", () => {
    const { out, status } = dryRun("dist/nosfry.sh", { glibc: "2.0" });
    expect(status).toBe(3);
    expect(out).toContain(
      `error: nosfry ${NOSFRY_V} (x86_64-unknown-linux-gnu) needs glibc >= ${F}; this host has glibc 2.0`,
    );
    expect(out).toContain("install from source: cargo install nosfry --locked");
    expect(out).not.toContain("Downloading");
  });

  test("host glibc above the floor picks the gnu asset quietly", () => {
    const { out, status } = dryRun("dist/nosfry.sh", { glibc: "99.0" });
    expect(status).toBe(0);
    expect(out).toContain("-x86_64-unknown-linux-gnu.tar.gz");
    expect(out).not.toContain("warning:");
  });

  test("host glibc equal to the floor is enough", () => {
    const { out, status } = dryRun("dist/nosfry.sh", { glibc: F });
    expect(status).toBe(0);
    expect(out).toContain("-x86_64-unknown-linux-gnu.tar.gz");
  });

  test("the compare is numeric, not decimal", () => {
    // nosfry's floor is 2.30: host "2.3" equals it as a decimal but its
    // minor 3 < 30, so a decimal comparison would wrongly accept it.
    expect(F_MINOR).toBeGreaterThanOrEqual(10);
    const { out, status } = dryRun("dist/nosfry.sh", { glibc: LEX_TRAP });
    expect(status).toBe(3);
    expect(out).toContain(`this host has glibc ${LEX_TRAP}`);
  });

  test("ldd is the fallback when getconf fails", () => {
    const { out, status } = dryRun("dist/nosfry.sh", { ldd: "ldd (GNU libc) 2.0" });
    expect(status).toBe(3);
    expect(out).toContain("this host has glibc 2.0");
  });

  test("undetectable host glibc warns once and picks gnu anyway", () => {
    const { out, status } = dryRun("dist/nosfry.sh", {});
    expect(status).toBe(0);
    expect(
      out.split("\n").filter((l) => l.includes("warning: could not determine the glibc version")),
    ).toHaveLength(1);
    expect(out).toContain("-x86_64-unknown-linux-gnu.tar.gz");
  });

  test("--quiet suppresses the undetectable-glibc warning", () => {
    const { out, status } = dryRun("dist/nosfry.sh", {}, ["--quiet"]);
    expect(status).toBe(0);
    expect(out).not.toContain("warning:");
  });

  test("the floor applies to variant builds too", () => {
    const { out, status } = dryRun("dist/nosfry.sh", { glibc: "2.0" }, ["--variant", "onion"]);
    expect(status).toBe(3);
    expect(out).toContain(`error: nosfry ${NOSFRY_V} onion (x86_64-unknown-linux-gnu) needs glibc`);
  });

  test("kobe falls back to its musl build below the gnu floor", () => {
    const { out, status } = dryRun("dist/kobe.sh", { glibc: "2.0" });
    expect(status).toBe(0);
    expect(out).toContain("-x86_64-unknown-linux-musl.tar.gz");
    expect(out).not.toContain("warning:");
  });

  test("a pinned --version has no floor data and only probes", () => {
    const { out, status } = dryRun("dist/kobe.sh", { glibc: "2.0" }, ["--version", KOBE_V]);
    expect(status).toBe(0);
    expect(out).toContain("Probing");
  });
});
