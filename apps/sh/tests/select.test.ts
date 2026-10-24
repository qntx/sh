import { describe, expect, test } from "vite-plus/test";

import type { LockEntry } from "../src/lock.ts";
import { selectRelease } from "../src/select.ts";
import { H, assetSet, fails, rel, sums } from "./fixtures/releases.ts";

const T1 = "x86_64-unknown-linux-gnu";
const T2 = "aarch64-apple-darwin";

describe("selectRelease", () => {
  test("picks highest semver, not the 'latest' or newest date", async () => {
    // xmtp-like: Latest is ffi-v0.2.0; CLI line is v0.9.3 plus backport v0.10.0
    const rs = [
      rel("ffi-v0.2.0", assetSet("xmtp", "0.2.0", [T1])),
      rel("v0.9.3", assetSet("xmtp", "0.9.3", [T1])),
      rel("v0.10.0", assetSet("xmtp", "0.10.0", [T1])),
      rel("v0.9.9", assetSet("xmtp", "0.9.9", [T1])),
    ];
    const s = await selectRelease("o/r", "xmtp", rs, undefined, false, sums);
    expect(s.version).toBe("0.10.0");
  });

  test("ignores drafts and prereleases", async () => {
    const rs = [
      rel("v2.0.0", assetSet("x", "2.0.0", [T1]), { draft: true }),
      rel("v3.0.0", assetSet("x", "3.0.0", [T1]), { prerelease: true }),
      rel("v1.0.0", assetSet("x", "1.0.0", [T1])),
    ];
    const s = await selectRelease("o/r", "x", rs, undefined, false, sums);
    expect(s.version).toBe("1.0.0");
  });

  test("missing .sha256 fails", async () => {
    const rs = [rel("v1.0.0", ["x-1.0.0-x86_64-unknown-linux-gnu.tar.gz"])];
    await fails(selectRelease("o/r", "x", rs, undefined, false, sums), "missing");
  });

  test("digest mismatch fails", async () => {
    const r = rel("v1.0.0", assetSet("x", "1.0.0", [T1]));
    for (const a of r.assets) {
      a.digest = `sha256:${"f".repeat(64)}`;
    }
    await fails(selectRelease("o/r", "x", [r], undefined, false, sums), "digest");
  });

  test("target shrink fails without force, passes with force", async () => {
    const prev: LockEntry = {
      version: "0.9.0",
      tag: "v0.9.0",
      commit: "a".repeat(40),
      immutable: false,
      description: "",
      assets: { [T1]: H, [T2]: H },
    };
    const rs = [rel("v1.0.0", assetSet("x", "1.0.0", [T1]))];
    await fails(selectRelease("o/r", "x", rs, prev, false, sums), "shrank");
    const s = await selectRelease("o/r", "x", rs, prev, true, sums);
    expect(s.version).toBe("1.0.0");
  });
});

describe("parseShaFile shared forms", () => {
  test.each([
    [`${H}  x-1.0.0-a.tar.gz\n`],
    [`${H} *x-1.0.0-a.tar.gz\n`],
    [`${H}  dist/x-1.0.0-a.tar.gz\n`],
  ])("accepts %j", async (content) => {
    const { parseShaFile } = await import("../src/select.ts");
    expect(parseShaFile(content, "x-1.0.0-a.tar.gz")).toBe(H);
  });

  test.each([
    [`${H}  other-name.tar.gz\n`],
    [`${H} single-space.tar.gz\n`],
    ["not hex  x-1.0.0-a.tar.gz\n"],
  ])("rejects %j", async (content) => {
    const { parseShaFile } = await import("../src/select.ts");
    expect(() => parseShaFile(content, "x-1.0.0-a.tar.gz")).toThrow(/.+/);
  });
});

test("x86_64-pc-windows-msvc zip is selected", async () => {
  const T = "x86_64-pc-windows-msvc";
  const rs = [rel("v1.0.0", assetSet("x", "1.0.0", [T]))];
  const s = await selectRelease("o/r", "x", rs, undefined, false, sums);
  expect(s.assets[T]).toBe(H);
});

test("unrecognized <bin>-<ver>-* asset fails selection", async () => {
  const assets = assetSet("x", "1.0.0", ["x86_64-unknown-linux-gnu"]);
  assets.push("x-1.0.0-x86_64-unknown-freebsd.tar.gz");
  assets.push("x-1.0.0-x86_64-unknown-freebsd.tar.gz.sha256");
  await fails(
    selectRelease("o/r", "x", [rel("v1.0.0", assets)], undefined, false, sums),
    "unrecognized asset",
  );
});

test("other-prefix assets (bux-guest, xmtp-ffi) stay ignored", async () => {
  const assets = assetSet("bux", "0.9.0", ["x86_64-unknown-linux-gnu"]);
  assets.push("bux-guest-x86_64.bin", "ffi-v0.2.0.tar.gz");
  const s = await selectRelease("o/r", "bux", [rel("v0.9.0", assets)], undefined, false, sums);
  expect(s.version).toBe("0.9.0");
});
