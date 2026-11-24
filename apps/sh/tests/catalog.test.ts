import { describe, expect, test } from "vite-plus/test";

import { parseCatalog } from "../src/catalog.ts";
import { parseLockEntry, parseReleases, validateReleases } from "../src/lock.ts";

const good = { tools: { kobe: { repo: "qntx/kobe", package: "kobe-cli" } } };

describe("parseCatalog", () => {
  test("accepts the real catalog", () => {
    const c = parseCatalog(good);
    expect(c["kobe"]?.repo).toBe("qntx/kobe");
    expect(c["kobe"]?.package).toBe("kobe-cli");
  });

  test.each([
    ["bad key case", { tools: { Kobe: { repo: "qntx/kobe" } } }],
    ["reserved index", { tools: { index: { repo: "qntx/kobe" } } }],
    ["reserved ps", { tools: { ps: { repo: "qntx/kobe" } } }],
    ["bad repo", { tools: { k: { repo: "not-a-repo" } } }],
    ["unknown field", { tools: { k: { repo: "qntx/kobe", windows: true } } }],
    ["root unknown", { tools: { k: { repo: "qntx/kobe" } }, extra: 1 }],
    ["unknown installer field", { tools: { k: { repo: "qntx/kobe", installer: "x" } } }],
    ["empty", { tools: {} }],
    ["empty variants", { tools: { k: { repo: "qntx/k", variants: [] } } }],
    ["bad variant case", { tools: { k: { repo: "qntx/k", variants: ["Onion"] } } }],
    ["bad variant dash", { tools: { k: { repo: "qntx/k", variants: ["on-ion"] } } }],
    ["bad variant digit", { tools: { k: { repo: "qntx/k", variants: ["1onion"] } } }],
    ["duplicate variant", { tools: { k: { repo: "qntx/k", variants: ["onion", "onion"] } } }],
    ["non-string variant", { tools: { k: { repo: "qntx/k", variants: [1] } } }],
    ["variants not array", { tools: { k: { repo: "qntx/k", variants: "onion" } } }],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseCatalog(raw)).toThrow(/.+/);
  });

  test("accepts declared variants", () => {
    const c = parseCatalog({ tools: { n: { repo: "qntx/nosfry", variants: ["onion"] } } });
    expect(c["n"]?.variants).toStrictEqual(["onion"]);
  });
});

const lock = {
  version: "6.0.0",
  tag: "v6.0.0",
  commit: "a".repeat(40),
  immutable: true,
  description: "x",
  assets: { "aarch64-apple-darwin": "b".repeat(64) },
};

describe("parseLockEntry", () => {
  test("accepts a valid entry", () => {
    expect(parseLockEntry("kobe", lock).version).toBe("6.0.0");
  });

  test.each([
    [{ ...lock, tag: "v6.0.1" }],
    [{ ...lock, assets: { "riscv64-linux": "b".repeat(64) } }],
    [{ ...lock, assets: {} }],
    [{ ...lock, assets: { "aarch64-apple-darwin": "BAD" } }],
    [{ ...lock, extra: 1 }],
    [{ ...lock, commit: "xyz" }],
    [{ ...lock, description: 'has "quotes"' }],
    [{ ...lock, variants: {} }],
    [{ ...lock, variants: "onion" }],
    [{ ...lock, variants: { Onion: { "aarch64-apple-darwin": "b".repeat(64) } } }],
    [{ ...lock, variants: { onion: {} } }],
    [{ ...lock, variants: { onion: { "riscv64-linux": "b".repeat(64) } } }],
    [{ ...lock, variants: { onion: { "aarch64-apple-darwin": "BAD" } } }],
  ])("rejects %o", (raw) => {
    expect(() => parseLockEntry("kobe", raw)).toThrow(/.+/);
  });

  test("accepts a locked variant", () => {
    const e = parseLockEntry("nosfry", {
      ...lock,
      variants: { onion: { "aarch64-apple-darwin": "c".repeat(64) } },
    });
    expect(e.variants).toStrictEqual({ onion: { "aarch64-apple-darwin": "c".repeat(64) } });
  });
});

describe("validateReleases", () => {
  const catalog = parseCatalog({
    tools: {
      kobe: { repo: "qntx/kobe" },
      nosfry: { repo: "qntx/nosfry", variants: ["onion"] },
    },
  });
  const releases = () => ({
    kobe: parseLockEntry("kobe", lock),
    nosfry: parseLockEntry("nosfry", { ...lock, tag: "v6.0.0" }),
  });

  test("declared variant absent from the lock is fine", () => {
    expect(() => validateReleases(catalog, releases())).not.toThrow();
  });

  test("locked variant must be declared", () => {
    const r = releases();
    r.nosfry = parseLockEntry("nosfry", {
      ...lock,
      variants: { onion: { "aarch64-apple-darwin": "c".repeat(64) } },
    });
    expect(() => validateReleases(catalog, r)).not.toThrow();
    r.kobe = parseLockEntry("kobe", {
      ...lock,
      variants: { onion: { "aarch64-apple-darwin": "c".repeat(64) } },
    });
    expect(() => validateReleases(catalog, r)).toThrow(/not declared/);
  });
});

test("parseReleases rejects bad key", () => {
  expect(() => parseReleases({ "Bad Key": lock })).toThrow(/.+/);
});
