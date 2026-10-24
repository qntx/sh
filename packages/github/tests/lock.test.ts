import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { lockJson, writeIfChanged } from "../src/lock.ts";

describe("lockJson", () => {
  test("sorted keys, 2-space indent, trailing newline", () => {
    const out = lockJson({ b: 1, a: { y: 2, x: 1 } });
    expect(out).toBe('{\n  "a": {\n    "y": 2,\n    "x": 1\n  },\n  "b": 1\n}\n');
    expect(Object.keys(JSON.parse(out))).toStrictEqual(["a", "b"]);
  });
});

describe("writeIfChanged", () => {
  test("writes only when content differs", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-lock-"));
    try {
      const p = join(dir, "f.json");
      expect(writeIfChanged(p, "a\n")).toBe(true);
      expect(writeIfChanged(p, "a\n")).toBe(false);
      expect(writeIfChanged(p, "b\n")).toBe(true);
      expect(readFileSync(p, "utf8")).toBe("b\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
