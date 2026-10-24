import { describe, expect, test } from "vite-plus/test";

import { nextLock, syncSource } from "../src/sync.ts";
import { ENC, SHA, deps, extraFileListDir } from "./fixtures.ts";

const NAME_ONLY = ENC.encode("---\nname: kobe\ndescription: d\n---\nx\n");

describe("syncSource", () => {
  test("uses the stable tag as ref when a release exists", async () => {
    const r = await syncSource("qntx/kobe", deps());
    expect(r.entry.ref).toBe("v1.0.0");
    expect(r.entry.commit).toBe(SHA);
    expect(Object.keys(r.entry.skills)).toStrictEqual(["kobe"]);
  });

  test("falls back to the default-branch commit SHA", async () => {
    const seen: string[] = [];
    const d = deps({
      releases: async () => Promise.resolve([]),
      commit: async (_n, ref) => {
        seen.push(ref);
        return Promise.resolve({ sha: SHA });
      },
    });
    const r = await syncSource("qntx/kobe", d);
    expect(r.entry.ref).toBe(SHA);
    expect(seen[0]).toBe("main");
  });

  test("extra file in a skill dir fails with the path", async () => {
    const d = deps({ listDir: extraFileListDir });
    await expect(syncSource("qntx/kobe", d)).rejects.toThrow(/skills\/kobe.*SKILL\.md/);
  });

  test("source with zero skills fails", async () => {
    const d = deps({ listDir: async () => Promise.resolve([]) });
    await expect(syncSource("qntx/kobe", d)).rejects.toThrow(/no skills/);
  });

  test("repo guard failures", async () => {
    await expect(
      syncSource(
        "qntx/kobe",
        deps({
          repo: async (n) =>
            Promise.resolve({
              full_name: n,
              private: true,
              archived: false,
              description: "",
              default_branch: "main",
            }),
        }),
      ),
    ).rejects.toThrow(/private/);
  });

  test("duplicate skill names fail validation", async () => {
    const d = deps({ fileAtRef: async () => Promise.resolve(NAME_ONLY) });
    const r = await syncSource("qntx/kobe", d);
    expect(Object.keys(r.entry.skills)).toStrictEqual(["kobe"]);
  });
});

describe("nextLock", () => {
  test("drops sources removed from skills.json", () => {
    const r = {
      source: "qntx/kobe",
      entry: { ref: "v1", commit: SHA, skills: { kobe: "x" } },
      files: new Map<string, Uint8Array>(),
    };
    const lock = nextLock(["qntx/kobe"], [r]);
    expect(Object.keys(lock)).toStrictEqual(["qntx/kobe"]);
    expect(nextLock([], [r])).toStrictEqual({});
  });
});
