// The vendored release-asset contract is the spec: its examples are the
// test corpus for parseAssetName, and its targets/layout must match what
// the installers actually implement (verified by reading the templates,
// not by restating them).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { TARGETS, archiveExt, examples, layoutMembers, parseContract } from "../src/contract.ts";
import { parseAssetName } from "../src/select.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmpl = (name: string): string => readFileSync(`${ROOT}templates/${name}`, "utf8");

// $_c_arch can be x86_64 or aarch64; the Linux candidate list is built
// as $_c_arch-<suffix>, plus a hard-coded darwin triple.
function shCandidates(sh: string): Set<string> {
  const archs = [...sh.matchAll(/(\b(?:x86_64|aarch64)) \| (?:amd64|arm64)\)/g)].map(
    (m) => m[1] ?? "",
  );
  const linuxSuffixes = [
    ...new Set([...sh.matchAll(/-unknown-linux-(?:musl|gnu)/g)].map((m) => m[0])),
  ];
  const candidates = new Set<string>();
  for (const a of archs) {
    for (const s of linuxSuffixes) {
      candidates.add(`${a}${s}`);
    }
  }
  for (const m of sh.matchAll(/'((?:x86_64|aarch64)-apple-darwin)'/g)) {
    candidates.add(m[1] ?? "");
  }
  return candidates;
}

function ps1Targets(ps1: string): Set<string> {
  return new Set([...ps1.matchAll(/'((?:x86_64|aarch64)-[a-z0-9-]+)'/g)].map((m) => m[1] ?? ""));
}

describe("contract targets", () => {
  test("the sh template's candidate triples equal TARGETS", () => {
    expect(shCandidates(tmpl("install.sh"))).toStrictEqual(
      new Set(TARGETS.filter((t) => archiveExt(t) === "tar.gz")),
    );
  });

  test("the PowerShell template's target triples equal TARGETS", () => {
    expect(ps1Targets(tmpl("install.ps1"))).toStrictEqual(
      new Set(TARGETS.filter((t) => archiveExt(t) === "zip")),
    );
  });
});

describe("contract layout", () => {
  test("install.sh extracts the flat then the nested member", () => {
    const sh = tmpl("install.sh");
    expect(sh).toContain('tar -xzf "$_i_tmp/$_i_asset" -C "$_i_tmp" "./$TOOL"');
    expect(sh).toContain('tar -xzf "$_i_tmp/$_i_asset" -C "$_i_tmp" "$_i_stem/$TOOL"');
    // The same two member names the contract derives.
    const [flat, nested] = layoutMembers("aarch64-apple-darwin", "$TOOL", "$_i_stem");
    expect(flat).toBe("./$TOOL");
    expect(nested).toBe("$_i_stem/$TOOL");
  });

  test("install.ps1 matches the flat and the nested member", () => {
    const ps1 = tmpl("install.ps1");
    expect(ps1).toContain('"$Tool.exe"');
    expect(ps1).toContain('"$stem/$Tool.exe"');
    const [flat, nested] = layoutMembers("x86_64-pc-windows-msvc", "$Tool", "$stem");
    expect(flat).toBe("$Tool.exe");
    expect(nested).toBe("$stem/$Tool.exe");
  });
});

describe("contract examples", () => {
  test.each(examples.valid.filter((e) => e.kind !== "aggregate"))("valid $name parses", (e) => {
    expect(parseAssetName(e.bin, e.version, e.name)).toStrictEqual({
      variant: e.variant,
      target: e.target,
      kind: e.kind,
    });
  });

  test.each(examples.valid.filter((e) => e.kind === "aggregate"))(
    "aggregate $name is outside the namespace",
    (e) => {
      expect(parseAssetName(e.bin, e.version, e.name)).toBeUndefined();
    },
  );

  test.each(examples.ignored)("ignored $name is outside the namespace", (e) => {
    expect(parseAssetName(e.bin, e.version, e.name)).toBeUndefined();
  });

  test.each(examples.invalid)("invalid $name is naming drift", (e) => {
    expect(() => parseAssetName(e.bin, e.version, e.name)).toThrow(/unrecognized asset/);
  });
});

describe("parseContract", () => {
  const valid = JSON.parse(readFileSync(`${ROOT}contract/release-assets.json`, "utf8")) as unknown;

  test("the vendored file parses", () => {
    const c = parseContract(valid);
    expect(c.targets).toHaveLength(TARGETS.length);
  });

  test.each([
    ["non-object root", 42],
    ["empty targets", { targets: [] }],
    [
      "duplicate triples",
      {
        targets: [
          { triple: "t", archive: "zip" },
          { triple: "t", archive: "zip" },
        ],
      },
    ],
    ["bad archive", { targets: [{ triple: "t", archive: "rar" }] }],
    [
      "one layout member",
      {
        targets: [{ triple: "t", archive: "zip" }],
        patterns: { variant: "^x$" },
        layout: { members: { "tar.gz": ["a"], zip: ["b", "c"] } },
      },
    ],
  ])("rejects %s", (_label, mutant) => {
    expect(() => parseContract(mutant)).toThrow(/^contract: /);
  });
});
