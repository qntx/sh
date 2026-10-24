import { describe, expect, test } from "vite-plus/test";

import { parseCatalog } from "../src/catalog.ts";
import { parseLockEntry, parseReleases } from "../src/lock.ts";

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
  ])("rejects %s", (_name, raw) => {
    expect(() => parseCatalog(raw)).toThrow(/.+/);
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
  ])("rejects %o", (raw) => {
    expect(() => parseLockEntry("kobe", raw)).toThrow(/.+/);
  });
});

test("parseReleases rejects bad key", () => {
  expect(() => parseReleases({ "Bad Key": lock })).toThrow(/.+/);
});
