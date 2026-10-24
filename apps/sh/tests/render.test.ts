import { describe, expect, test } from "vite-plus/test";

import type { ToolSpec } from "../src/catalog.ts";
import type { LockEntry } from "../src/lock.ts";
import { renderSh, substitute } from "../src/render.ts";

const spec: ToolSpec = { repo: "qntx/kobe", package: "kobe-cli" };
const lock: LockEntry = {
  version: "6.0.0",
  tag: "v6.0.0",
  commit: "a".repeat(40),
  immutable: true,
  description: "x",
  assets: { "aarch64-apple-darwin": "b".repeat(64) },
};

describe("substitute", () => {
  test("missing marker fails", () => {
    expect(() => substitute("no marker\n", "x")).toThrow("missing");
  });

  test("duplicated marker fails", () => {
    expect(() => substitute("# @qntx-constants\n# @qntx-constants\n", "x")).toThrow("duplicated");
  });
});

describe("renderSh", () => {
  test("invalid version rejected", () => {
    expect(() => renderSh("kobe", spec, { ...lock, version: "6; rm -rf /" })).toThrow("unsafe");
  });

  test("constants block for kobe", () => {
    expect(renderSh("kobe", spec, lock)).toBe(
      [
        "TOOL='kobe'",
        "REPO='qntx/kobe'",
        "PACKAGE='kobe-cli'",
        "VERSION='6.0.0'",
        "ENV_PREFIX='KOBE'",
        // oxlint-disable-next-line no-template-curly-in-string
        "CFG_VERSION=${KOBE_VERSION-}",
        // oxlint-disable-next-line no-template-curly-in-string
        "CFG_INSTALL_DIR=${KOBE_INSTALL_DIR-}",
        // oxlint-disable-next-line no-template-curly-in-string
        "CFG_NO_MODIFY_PATH=${KOBE_NO_MODIFY_PATH-}",
        "asset_sha256() {",
        '    case "$1" in',
        `        aarch64-apple-darwin) printf '%s' '${"b".repeat(64)}' ;;`,
        "        *) return 1 ;;",
        "    esac",
        "}",
      ].join("\n"),
    );
  });
});

describe("assertAscii", () => {
  test("accepts tab/LF/CR/printable", async () => {
    const { assertAscii } = await import("../src/render.ts");
    expect(() => assertAscii("x", "a\tb\nc\rd ~!@#\u007E")).not.toThrow();
  });

  test.each([
    ["U+2026 ellipsis", "sha256 abc…def"],
    ["U+00E9 accent", "café"],
    ["NUL", "a\u0000b"],
    ["DEL", "a\u007Fb"],
  ])("rejects %s", async (_n, content) => {
    const { assertAscii } = await import("../src/render.ts");
    expect(() => assertAscii("x", content)).toThrow("non-ASCII");
  });
});
