import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type { LockEntry } from "../src/lock.ts";
import { changed, loadReleases, mergeReleases } from "../src/lock.ts";

const entry = (version: string, assets: Record<string, string>): LockEntry => ({
  version,
  tag: `v${version}`,
  commit: "a".repeat(40),
  immutable: false,
  description: "",
  assets,
});

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("loadReleases", () => {
  test("missing file starts empty", () => {
    expect(loadReleases(join(tmpdir(), "does-not-exist-sh.json"))).toStrictEqual({});
  });

  test("invalid file fails loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "sh-lock-"));
    try {
      const p = join(dir, "releases.json");
      writeFileSync(p, "{ not json }");
      expect(() => loadReleases(p)).toThrow(/.+/);
      writeFileSync(p, '{"kobe":{"version":"x"}}');
      expect(() => loadReleases(p)).toThrow(/.+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("changed", () => {
  const prev = entry("1.0.0", { t1: H1 });
  const sel = {
    version: "1.0.0",
    tag: "v1.0.0",
    assets: { t1: H1 },
    variants: {} as Record<string, Record<string, string>>,
    skipped: [] as string[],
    unpublished: [] as string[],
  };

  test("unchanged", () => {
    expect(changed(prev, sel, false)).toBe(false);
  });

  test("skipped variants do not re-verify", () => {
    expect(changed(prev, { ...sel, skipped: ["onion"] }, false)).toBe(false);
  });

  test("unpublished declared variants do not re-verify", () => {
    expect(changed(prev, { ...sel, unpublished: ["onion"] }, false)).toBe(false);
  });

  test("new locked variant re-verifies", () => {
    const s = { ...sel, variants: { onion: { t1: H1 } } };
    expect(changed(prev, s, false)).toBe(true);
  });

  test("removed locked variant re-verifies", () => {
    const p: LockEntry = { ...prev, variants: { onion: { t1: H1 } } };
    expect(changed(p, sel, false)).toBe(true);
  });

  test("variant hash change re-verifies", () => {
    const p: LockEntry = { ...prev, variants: { onion: { t1: H1 } } };
    const s = { ...sel, variants: { onion: { t1: H2 } } };
    expect(changed(p, s, false)).toBe(true);
  });

  test("unchanged locked variant does not re-verify", () => {
    const p: LockEntry = { ...prev, variants: { onion: { t1: H1 } } };
    const s = { ...sel, variants: { onion: { t1: H1 } } };
    expect(changed(p, s, false)).toBe(false);
  });

  test("hash change re-verifies", () => {
    expect(changed(prev, { ...sel, assets: { t1: H2 } }, false)).toBe(true);
  });

  test("target added", () => {
    expect(changed(prev, { ...sel, assets: { t1: H1, t2: H1 } }, false)).toBe(true);
  });

  test("version bump", () => {
    expect(changed(prev, { ...sel, version: "1.0.1" }, false)).toBe(true);
  });

  test("no previous", () => {
    expect(changed(undefined, sel, false)).toBe(true);
  });
});

describe("mergeReleases", () => {
  const catalog = {
    a: { repo: "o/a", installer: "template" as const },
    b: { repo: "o/b", installer: "template" as const },
  };

  test("drops catalog-removed keys, keeps prior entries for unsynced", () => {
    const prev = {
      a: entry("1.0.0", { t: H1 }),
      b: entry("2.0.0", { t: H1 }),
      gone: entry("3.0.0", { t: H1 }),
    };
    const results = [{ key: "a", entry: entry("1.1.0", { t: H2 }) }];
    const next = mergeReleases(catalog, prev, results);
    expect(Object.keys(next)).toStrictEqual(["a", "b"]);
    expect(next["a"]?.version).toBe("1.1.0");
    expect(next["b"]?.version).toBe("2.0.0");
  });
});

describe("pickToolKeys", () => {
  const keys = ["kobe", "nosfry"];

  test('undefined and "" both mean all tools', async () => {
    const { pickToolKeys } = await import("../src/lock.ts");
    expect(pickToolKeys(keys, undefined)).toStrictEqual(keys);
    expect(pickToolKeys(keys, "")).toStrictEqual(keys);
    expect(pickToolKeys(keys, "kobe")).toStrictEqual(["kobe"]);
  });
});
