import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { parseStatus, settle, writeStatus } from "../src/status.ts";

describe("settle", () => {
  test("collects results and failures in order", async () => {
    const seen: string[] = [];
    const impl: Record<string, () => string> = {
      a: () => "v-a",
      b: () => {
        throw new Error("boom b");
      },
      c: () => "v-c",
    };
    const { results, status } = await settle(["a", "b", "c"], async (k) => {
      seen.push(k);
      const v = await Promise.resolve(impl[k]!());
      return v;
    });
    expect(seen).toStrictEqual(["a", "b", "c"]);
    expect(results.get("a")).toBe("v-a");
    expect(results.get("c")).toBe("v-c");
    expect(results.has("b")).toBe(false);
    expect(status).toStrictEqual({ ok: ["a", "c"], failed: { b: "boom b" } });
  });

  test("non-Error throws are stringified", async () => {
    const { status } = await settle(["x"], async () => {
      // oxlint-disable-next-line prefer-promise-reject-errors
      return Promise.reject("plain string");
    });
    expect(status.failed["x"]).toBe("plain string");
  });

  test("empty key list", async () => {
    const { results, status } = await settle([], async () => {
      const v = await Promise.resolve(1);
      return v;
    });
    expect(results.size).toBe(0);
    expect(status).toStrictEqual({ ok: [], failed: {} });
  });
});

describe("writeStatus", () => {
  test("undefined and empty paths are no-ops", () => {
    expect(() => {
      writeStatus(undefined, { ok: [], failed: {} });
      writeStatus("", { ok: [], failed: {} });
    }).not.toThrow();
  });

  test("writes sorted JSON with a trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-status-"));
    try {
      const p = join(dir, "status.json");
      writeStatus(p, { ok: ["b", "a"], failed: { z: "e1", m: "e2" } });
      const text = readFileSync(p, "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(JSON.parse(text)).toStrictEqual({
        ok: ["a", "b"],
        failed: { m: "e2", z: "e1" },
      });
      expect(text).toBe(
        '{\n  "ok": [\n    "a",\n    "b"\n  ],\n  "failed": {\n    "m": "e2",\n    "z": "e1"\n  }\n}\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips through parseStatus", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-status-"));
    try {
      const p = join(dir, "status.json");
      const status = { ok: ["a"], failed: { b: "oops" } };
      writeStatus(p, status);
      expect(parseStatus(JSON.parse(readFileSync(p, "utf8")))).toStrictEqual(status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseStatus", () => {
  test("accepts the canonical shape", () => {
    expect(parseStatus({ ok: ["a"], failed: { b: "m" } })).toStrictEqual({
      ok: ["a"],
      failed: { b: "m" },
    });
    expect(parseStatus({ ok: [], failed: {} })).toStrictEqual({ ok: [], failed: {} });
  });

  test.each([
    ["not an object", 42],
    ["missing ok", { failed: {} }],
    ["missing failed", { ok: [] }],
    ["ok not array", { ok: "a", failed: {} }],
    ["ok not strings", { ok: [1], failed: {} }],
    ["failed not object", { ok: [], failed: [] }],
    ["failed value not string", { ok: [], failed: { a: 1 } }],
    ["unknown field", { ok: [], failed: {}, extra: 1 }],
  ])("rejects %s", (_n, raw) => {
    expect(() => parseStatus(raw)).toThrow(/.+/);
  });
});
