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
  assets: { "aarch64-apple-darwin": { sha256: "b".repeat(64) } },
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

  test("invalid variant name rejected", () => {
    const bad: ToolSpec = { ...spec, variants: ["on-ion"] };
    expect(() => renderSh("kobe", bad, lock)).toThrow("unsafe");
  });

  test("constants block for kobe", () => {
    expect(renderSh("kobe", spec, lock)).toBe(
      [
        "TOOL='kobe'",
        "REPO='qntx/kobe'",
        "PACKAGE='kobe-cli'",
        "VERSION='6.0.0'",
        "ENV_PREFIX='KOBE'",
        "VARIANTS=''",
        // oxlint-disable-next-line no-template-curly-in-string
        "CFG_VERSION=${KOBE_VERSION-}",
        // oxlint-disable-next-line no-template-curly-in-string
        "CFG_INSTALL_DIR=${KOBE_INSTALL_DIR-}",
        // oxlint-disable-next-line no-template-curly-in-string
        "CFG_NO_MODIFY_PATH=${KOBE_NO_MODIFY_PATH-}",
        // oxlint-disable-next-line no-template-curly-in-string
        "CFG_VARIANT=${KOBE_VARIANT-}",
        "asset_sha256() {",
        '    case "$1" in',
        `        aarch64-apple-darwin) printf '%s' '${"b".repeat(64)}' ;;`,
        "        *) return 1 ;;",
        "    esac",
        "}",
        "asset_glibc() {",
        '    case "$1" in',
        "        *) return 1 ;;",
        "    esac",
        "}",
      ].join("\n"),
    );
  });

  test("unsafe glibc floor rejected", () => {
    const bad: LockEntry = {
      ...lock,
      assets: { "x86_64-unknown-linux-gnu": { sha256: "b".repeat(64), glibc: "2; rm -rf /" } },
    };
    expect(() => renderSh("kobe", spec, bad)).toThrow("unsafe");
  });

  test("variant constants block", () => {
    const vSpec: ToolSpec = { repo: "qntx/nosfry", variants: ["onion"] };
    const vLock: LockEntry = {
      ...lock,
      assets: { "x86_64-unknown-linux-gnu": { sha256: "b".repeat(64), glibc: "2.39" } },
      variants: {
        onion: {
          "aarch64-apple-darwin": { sha256: "c".repeat(64) },
          "x86_64-unknown-linux-gnu": { sha256: "d".repeat(64), glibc: "2.39" },
        },
      },
    };
    const out = renderSh("nosfry", vSpec, vLock);
    expect(out).toContain("VARIANTS='onion'");
    // oxlint-disable-next-line no-template-curly-in-string
    expect(out).toContain("CFG_VARIANT=${NOSFRY_VARIANT-}");
    expect(out).toContain(`x86_64-unknown-linux-gnu) printf '%s' '${"b".repeat(64)}' ;;`);
    expect(out).toContain(`onion/aarch64-apple-darwin) printf '%s' '${"c".repeat(64)}' ;;`);
    expect(out).toContain("x86_64-unknown-linux-gnu) printf '%s' '2.39' ;;");
    expect(out).toContain("onion/x86_64-unknown-linux-gnu) printf '%s' '2.39' ;;");
  });
});

describe("renderPs1", () => {
  test("variant hash keys and list", async () => {
    const { renderPs1 } = await import("../src/render.ts");
    const vSpec: ToolSpec = { repo: "qntx/nosfry", variants: ["onion"] };
    const vLock: LockEntry = {
      ...lock,
      variants: { onion: { "x86_64-pc-windows-msvc": { sha256: "d".repeat(64) } } },
    };
    const out = renderPs1("nosfry", vSpec, vLock);
    expect(out).toContain("$Variants = @('onion')");
    expect(out).toContain(`'aarch64-apple-darwin' = '${"b".repeat(64)}'`);
    expect(out).toContain(`'onion/x86_64-pc-windows-msvc' = '${"d".repeat(64)}'`);
  });

  test("no variants renders an empty list", async () => {
    const { renderPs1 } = await import("../src/render.ts");
    expect(renderPs1("kobe", spec, lock)).toContain("$Variants = @()");
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
