import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import type { Release } from "@qntx/sync";

import type { LockEntry } from "../src/lock.ts";
import { parseAssetName, selectRelease } from "../src/select.ts";
import { H, assetSet, fails, rel, sums } from "./fixtures/releases.ts";

const T1 = "x86_64-unknown-linux-gnu";
const T2 = "aarch64-apple-darwin";

const KOBE_LOCK_SHA256 = Object.fromEntries(
  Object.entries(
    (
      JSON.parse(
        readFileSync(fileURLToPath(new URL("../releases.json", import.meta.url)), "utf8"),
      ) as Record<string, { assets: Record<string, { sha256: string }> }>
    )["kobe"]?.assets ?? {},
  ).map(([t, a]) => [t, a.sha256]),
);

describe("selectRelease", () => {
  test("picks highest semver, not the 'latest' or newest date", async () => {
    // xmtp-like: Latest is ffi-v0.2.0; CLI line is v0.9.3 plus backport v0.10.0
    const rs = [
      rel("ffi-v0.2.0", assetSet("xmtp", "0.2.0", [T1])),
      rel("v0.9.3", assetSet("xmtp", "0.9.3", [T1])),
      rel("v0.10.0", assetSet("xmtp", "0.10.0", [T1])),
      rel("v0.9.9", assetSet("xmtp", "0.9.9", [T1])),
    ];
    const s = await selectRelease("o/r", "xmtp", rs, undefined, false, [], sums);
    expect(s.version).toBe("0.10.0");
  });

  test("ignores drafts and prereleases", async () => {
    const rs = [
      rel("v2.0.0", assetSet("x", "2.0.0", [T1]), { draft: true }),
      rel("v3.0.0", assetSet("x", "3.0.0", [T1]), { prerelease: true }),
      rel("v1.0.0", assetSet("x", "1.0.0", [T1])),
    ];
    const s = await selectRelease("o/r", "x", rs, undefined, false, [], sums);
    expect(s.version).toBe("1.0.0");
  });

  test("missing .sha256 fails", async () => {
    const rs = [rel("v1.0.0", ["x-1.0.0-x86_64-unknown-linux-gnu.tar.gz"])];
    await fails(selectRelease("o/r", "x", rs, undefined, false, [], sums), "missing");
  });

  test("digest mismatch fails", async () => {
    const r = rel("v1.0.0", assetSet("x", "1.0.0", [T1]));
    for (const a of r.assets) {
      a.digest = `sha256:${"f".repeat(64)}`;
    }
    await fails(selectRelease("o/r", "x", [r], undefined, false, [], sums), "digest");
  });

  test("target shrink fails without force, passes with force", async () => {
    const prev: LockEntry = {
      version: "0.9.0",
      tag: "v0.9.0",
      commit: "a".repeat(40),
      immutable: false,
      description: "",
      assets: { [T1]: { sha256: H }, [T2]: { sha256: H } },
    };
    const rs = [rel("v1.0.0", assetSet("x", "1.0.0", [T1]))];
    await fails(selectRelease("o/r", "x", rs, prev, false, [], sums), "shrank");
    const s = await selectRelease("o/r", "x", rs, prev, true, [], sums);
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
  const s = await selectRelease("o/r", "x", rs, undefined, false, [], sums);
  expect(s.assets[T]).toBe(H);
});

test("unrecognized <bin>-<ver>-* asset fails selection", async () => {
  const assets = assetSet("x", "1.0.0", ["x86_64-unknown-linux-gnu"]);
  assets.push("x-1.0.0-x86_64-unknown-freebsd.tar.gz");
  assets.push("x-1.0.0-x86_64-unknown-freebsd.tar.gz.sha256");
  await fails(
    selectRelease("o/r", "x", [rel("v1.0.0", assets)], undefined, false, [], sums),
    "unrecognized asset",
  );
});

test("other-prefix assets (bux-guest, xmtp-ffi) stay ignored", async () => {
  const assets = assetSet("bux", "0.9.0", ["x86_64-unknown-linux-gnu"]);
  assets.push("bux-guest-x86_64.bin", "ffi-v0.2.0.tar.gz");
  const s = await selectRelease("o/r", "bux", [rel("v0.9.0", assets)], undefined, false, [], sums);
  expect(s.version).toBe("0.9.0");
});

type Recorded = { release: Release; sha256: Record<string, string> };

function recorded(name: string): Recorded {
  const p = fileURLToPath(new URL(`fixtures/recorded/${name}`, import.meta.url));
  return JSON.parse(readFileSync(p, "utf8")) as Recorded;
}

function fixtureSums(fx: Recorded, calls: string[]) {
  return (_r: Release, name: string): string => {
    calls.push(name);
    const t = fx.sha256[name];
    if (t === undefined) {
      throw new Error(`unexpected .sha256 request: ${name}`);
    }
    return t;
  };
}

describe("recorded fixtures", () => {
  test("nosfry v0.4.0: variants skipped, SBOMs ignored", async () => {
    const fx = recorded("nosfry-v0.4.0.json");
    const calls: string[] = [];
    const s = await selectRelease(
      "qntx/nosfry",
      "nosfry",
      [fx.release],
      undefined,
      false,
      [],
      fixtureSums(fx, calls),
    );
    expect(s.version).toBe("0.4.0");
    expect(s.assets).toStrictEqual({
      "x86_64-unknown-linux-gnu":
        "d36f4a92972f79c1d2847f2fc45096d002b23c1ebc1f3dd3bf89ef2fa443e737",
      "aarch64-unknown-linux-gnu":
        "ce8de61285089928dcfa8482234e3e9babe59d5a065c1c5a8275de68de11c9b1",
      "aarch64-apple-darwin": "3e36f0471e94cd01c1a5421afb67968241dafb5ef6b6ec16906047896a589abc",
    });
    expect(s.skipped).toStrictEqual(["onion"]);
    expect(s.unpublished).toStrictEqual([]);
    expect(calls.toSorted()).toStrictEqual([
      "nosfry-0.4.0-aarch64-apple-darwin.tar.gz.sha256",
      "nosfry-0.4.0-aarch64-unknown-linux-gnu.tar.gz.sha256",
      "nosfry-0.4.0-x86_64-unknown-linux-gnu.tar.gz.sha256",
    ]);
  });

  test("nosfry v0.4.0 with onion declared locks both builds", async () => {
    const fx = recorded("nosfry-v0.4.0.json");
    const calls: string[] = [];
    const s = await selectRelease(
      "qntx/nosfry",
      "nosfry",
      [fx.release],
      undefined,
      false,
      ["onion"],
      fixtureSums(fx, calls),
    );
    expect(s.version).toBe("0.4.0");
    expect(s.variants).toStrictEqual({
      onion: {
        "x86_64-unknown-linux-gnu":
          "5c831a5ea280305587a551a74289ad31e91cb726f00eb0a96a49ce106e59afdb",
        "aarch64-unknown-linux-gnu":
          "e11d55ab4ec57fe708982c99821eba857d755447a07aee6ee06c1774dae204fd",
        "aarch64-apple-darwin": "e23e37bbbf96e8a4f5fe220d93b24d3735c3cecffd4a4d5f8e1a60615f01941f",
      },
    });
    expect(s.skipped).toStrictEqual([]);
    expect(s.unpublished).toStrictEqual([]);
    expect(calls.toSorted()).toStrictEqual([
      "nosfry-0.4.0-aarch64-apple-darwin.tar.gz.sha256",
      "nosfry-0.4.0-aarch64-unknown-linux-gnu.tar.gz.sha256",
      "nosfry-0.4.0-onion-aarch64-apple-darwin.tar.gz.sha256",
      "nosfry-0.4.0-onion-aarch64-unknown-linux-gnu.tar.gz.sha256",
      "nosfry-0.4.0-onion-x86_64-unknown-linux-gnu.tar.gz.sha256",
      "nosfry-0.4.0-x86_64-unknown-linux-gnu.tar.gz.sha256",
    ]);
  });

  test("kobe v7.0.0 matches the locked asset map", async () => {
    const fx = recorded("kobe-v7.0.0.json");
    const calls: string[] = [];
    const s = await selectRelease(
      "qntx/kobe",
      "kobe",
      [fx.release],
      undefined,
      false,
      [],
      fixtureSums(fx, calls),
    );
    expect(s.version).toBe("7.0.0");
    expect(s.assets).toStrictEqual(KOBE_LOCK_SHA256);
    expect(s.skipped).toStrictEqual([]);
    expect(calls).toHaveLength(7);
  });
});

describe("parseAssetName", () => {
  test.each<[string, { variant: string | undefined; target: string; kind: string }]>([
    [
      "x-1.0.0-aarch64-apple-darwin.tar.gz",
      { variant: undefined, target: "aarch64-apple-darwin", kind: "archive" },
    ],
    [
      "x-1.0.0-x86_64-pc-windows-msvc.zip",
      { variant: undefined, target: "x86_64-pc-windows-msvc", kind: "archive" },
    ],
    [
      "x-1.0.0-aarch64-apple-darwin.tar.gz.sha256",
      { variant: undefined, target: "aarch64-apple-darwin", kind: "sha256" },
    ],
    [
      "x-1.0.0-aarch64-apple-darwin.cdx.json",
      { variant: undefined, target: "aarch64-apple-darwin", kind: "sbom" },
    ],
    [
      "x-1.0.0-onion-aarch64-apple-darwin.tar.gz",
      { variant: "onion", target: "aarch64-apple-darwin", kind: "archive" },
    ],
    [
      "x-1.0.0-onion-aarch64-apple-darwin.tar.gz.sha256",
      { variant: "onion", target: "aarch64-apple-darwin", kind: "sha256" },
    ],
    [
      "x-1.0.0-onion-aarch64-apple-darwin.cdx.json",
      { variant: "onion", target: "aarch64-apple-darwin", kind: "sbom" },
    ],
  ])("parses %s", (name, want) => {
    expect(parseAssetName("x", "1.0.0", name)).toStrictEqual(want);
  });

  test.each(["SHA256SUMS", "bux-guest-x86_64.bin", "x-2.0.0-aarch64-apple-darwin.tar.gz"])(
    "ignores %s",
    (name) => {
      expect(parseAssetName("x", "1.0.0", name)).toBeUndefined();
    },
  );

  test.each([
    "x-1.0.0-x86_64-unknown-freebsd.tar.gz",
    "x-1.0.0-x86_64-unknown-linux-gnu.tar.xz",
    "x-1.0.0-x86_64-unknown-linux-gnu.tar.gz.sig",
    "x-1.0.0-aarch64-apple-darwn.tar.gz",
    "x-1.0.0-onion-aarch64-unknown-linux-gun.tar.gz",
    "x-1.0.0-x86_64-pc-windows-msvc.tar.gz",
    "x-1.0.0-Onion-x86_64-unknown-linux-gnu.tar.gz",
    "x-1.0.0-on-ion-x86_64-unknown-linux-gnu.tar.gz",
    "x-1.0.0-x86_64-unknown-linux-gnu.cdx.json.sha256",
    "x-1.0.0-x86_64-unknown-freebsd.cdx.json",
  ])("rejects %s", async (name) => {
    expect(() => parseAssetName("x", "1.0.0", name)).toThrow(/unrecognized asset/);
    const assets = [...assetSet("x", "1.0.0", ["x86_64-unknown-linux-gnu"]), name];
    await fails(
      selectRelease("o/r", "x", [rel("v1.0.0", assets)], undefined, false, [], sums),
      "unrecognized asset",
    );
  });
});

describe("SBOM and variant selection rules", () => {
  test("orphan default-variant .cdx.json fails", async () => {
    const assets = [
      ...assetSet("x", "1.0.0", ["x86_64-unknown-linux-gnu"]),
      "x-1.0.0-aarch64-apple-darwin.cdx.json",
    ];
    await fails(
      selectRelease("o/r", "x", [rel("v1.0.0", assets)], undefined, false, [], sums),
      "has no archive",
    );
  });

  test("undeclared variant with an incomplete set is still skipped", async () => {
    const assets = [
      ...assetSet("x", "1.0.0", ["x86_64-unknown-linux-gnu"]),
      "x-1.0.0-onion-x86_64-unknown-linux-gnu.tar.gz",
    ];
    const s = await selectRelease("o/r", "x", [rel("v1.0.0", assets)], undefined, false, [], sums);
    expect(s.skipped).toStrictEqual(["onion"]);
    expect(s.assets["x86_64-unknown-linux-gnu"]).toBe(H);
  });

  test("declared variant with no assets in the release is unpublished", async () => {
    const assets = assetSet("x", "1.0.0", ["x86_64-unknown-linux-gnu"]);
    const s = await selectRelease(
      "o/r",
      "x",
      [rel("v1.0.0", assets)],
      undefined,
      false,
      ["onion"],
      sums,
    );
    expect(s.unpublished).toStrictEqual(["onion"]);
    expect(s.variants).toStrictEqual({});
    expect(s.skipped).toStrictEqual([]);
  });

  test("declared variant is verified like the default build", async () => {
    const assets = [
      ...assetSet("x", "1.0.0", ["x86_64-unknown-linux-gnu"]),
      "x-1.0.0-onion-x86_64-unknown-linux-gnu.tar.gz",
      "x-1.0.0-onion-x86_64-unknown-linux-gnu.tar.gz.sha256",
      // Orphan SBOM under the variant: fails like the default build.
      "x-1.0.0-onion-aarch64-apple-darwin.cdx.json",
    ];
    await fails(
      selectRelease("o/r", "x", [rel("v1.0.0", assets)], undefined, false, ["onion"], sums),
      "has no archive",
    );
    // Missing the variant's .sha256 fails too.
    const assets2 = [
      ...assetSet("x", "1.0.0", ["x86_64-unknown-linux-gnu"]),
      "x-1.0.0-onion-x86_64-unknown-linux-gnu.tar.gz",
    ];
    await fails(
      selectRelease("o/r", "x", [rel("v1.0.0", assets2)], undefined, false, ["onion"], sums),
      "missing",
    );
  });

  test("shrinking a locked variant's targets fails", async () => {
    const prev: LockEntry = {
      version: "0.9.0",
      tag: "v0.9.0",
      commit: "a".repeat(40),
      immutable: false,
      description: "",
      assets: { [T1]: { sha256: H } },
      variants: { onion: { [T1]: { sha256: H }, [T2]: { sha256: H } } },
    };
    const assets = [
      ...assetSet("x", "1.0.0", [T1]),
      ...assetSet("x", "1.0.0", [T1]).map((n) => n.replace("x-1.0.0-", "x-1.0.0-onion-")),
    ];
    await fails(
      selectRelease("o/r", "x", [rel("v1.0.0", assets)], prev, false, ["onion"], sums),
      "lost onion/aarch64-apple-darwin",
    );
    const s = await selectRelease("o/r", "x", [rel("v1.0.0", assets)], prev, true, ["onion"], sums);
    expect(s.variants["onion"]).toStrictEqual({ [T1]: H });
  });

  test("a locked variant that vanished entirely fails", async () => {
    const prev: LockEntry = {
      version: "0.9.0",
      tag: "v0.9.0",
      commit: "a".repeat(40),
      immutable: false,
      description: "",
      assets: { [T1]: { sha256: H } },
      variants: { onion: { [T1]: { sha256: H } } },
    };
    const assets = assetSet("x", "1.0.0", [T1]);
    await fails(
      selectRelease("o/r", "x", [rel("v1.0.0", assets)], prev, false, ["onion"], sums),
      `lost onion/${T1}`,
    );
  });
});
