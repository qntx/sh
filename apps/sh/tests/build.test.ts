import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, test } from "vite-plus/test";

// build was run before tests (bun run check order); assert the dist contract.
const files = readdirSync("dist").toSorted();

describe("dist", () => {
  test("file set", () => {
    for (const f of [
      "index.sh",
      "index.ps1",
      "kobe.sh",
      "kobe.ps1",
      "nosfry.sh",
      "nosfry.ps1",
      "_redirects",
      "_headers",
    ]) {
      expect(files).toContain(f);
    }
  });

  test("_redirects", () => {
    const r = readFileSync("dist/_redirects", "utf8").split("\n");
    expect(r[0]).toBe("/ /index.sh 200");
    expect(r[1]).toBe("/ps /index.ps1 200");
    expect(r).toContain("/kobe /kobe.sh 200");
    expect(r).toContain("/kobe/ps /kobe.ps1 200");
    expect(r).toContain("/nosfry /nosfry.sh 200");
    expect(r).toContain("/nosfry/ps /nosfry.ps1 200");
  });

  test("_headers", () => {
    expect(readFileSync("dist/_headers", "utf8")).toBe(
      "/*\n  Content-Type: text/plain; charset=utf-8\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex\n  Referrer-Policy: no-referrer\n",
    );
  });

  test("no marker left in rendered scripts", () => {
    for (const f of files.filter((n) => n.endsWith(".sh"))) {
      expect(readFileSync(`dist/${f}`, "utf8")).not.toContain("@qntx-constants");
    }
  });
});
