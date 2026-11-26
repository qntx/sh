// The glibc floor reader against real compiler-built fixtures
// (tests/fixtures/elf/build.sh): a glibc-2.28 x86_64 binary, a
// glibc-2.39 aarch64 one and a static musl one, plus byte-patched and
// truncated copies. Fixtures/readelf.txt records what readelf sees in
// them; the expectations below match that.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import type { VersionNeed } from "../src/elf.ts";
import { ElfError, glibcFloor, versionNeeds } from "../src/elf.ts";

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`fixtures/elf/${name}`, import.meta.url))),
  );
}

const X86 = fixture("glibc-2.28-x86_64.elf");
const ARM = fixture("glibc-2.39-aarch64.elf");
const MUSL = fixture("musl-static-x86_64.elf");

function patched(buf: Uint8Array, off: number, value: number): Uint8Array {
  const out = new Uint8Array(buf);
  out[off] = value;
  return out;
}

// Overwrite every `find` byte sequence with `with` (same length).
function patchName(
  buf: Uint8Array,
  find: string,
  with_: string,
): { buf: Uint8Array; hits: number } {
  const name = new TextEncoder().encode(find);
  const priv = new TextEncoder().encode(with_);
  const out = new Uint8Array(buf);
  let hits = 0;
  for (let i = 0; i + name.length <= out.length; i += 1) {
    if (name.every((b, j) => out[i + j] === b)) {
      out.set(priv, i);
      hits += 1;
    }
  }
  return { buf: out, hits };
}

// The floor glibcFloor should report once `dropped` ("2.39") is patched
// out of the dynstr: the numeric max over the remaining GLIBC_x.y needs.
function expectedFloor(buf: Uint8Array, dropped: string): string {
  const remain: number[][] = versionNeeds(buf)
    .map((n: VersionNeed) => /^GLIBC_(\d+(?:\.\d+)+)$/.exec(n.name)?.[1])
    .filter((v): v is string => v !== undefined && v !== dropped)
    .map((v) => v.split(".").map(Number));
  let best: number[] = [0, 0];
  for (const parts of remain) {
    if (cmpVer(parts, best) > 0) {
      best = parts;
    }
  }
  return `${best[0] ?? 0}.${best[1] ?? 0}`;
}

function cmpVer(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

// vna_hash — the standard SysV ELF hash — of "GLIBC_2.39".
const HASH_GLIBC_239 = 0x069691b9;

// Every offset where u32 `val` appears little-endian in `buf`.
function u32Offsets(buf: Uint8Array, val: number): number[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const offs: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (v.getUint32(i, true) === val) {
      offs.push(i);
    }
  }
  return offs;
}

// The offset of the Vernaux whose vna_hash is `hash` — throws unless
// the hash appears exactly once in the file.
function vernauxOff(buf: Uint8Array, hash: number): number {
  const offs = u32Offsets(buf, hash);
  if (offs.length !== 1) {
    throw new Error(`vna_hash ${hash.toString(16)}: ${offs.length} occurrences`);
  }
  return offs[0] ?? 0;
}

// File offset of the DT_VERNEEDNUM entry's value field, found through
// the same program-header path the reader uses.
function verneedNumOff(buf: Uint8Array): number {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const phoff = Number(v.getBigUint64(0x20, true));
  const phentsize = v.getUint16(0x36, true);
  const phnum = v.getUint16(0x38, true);
  for (let i = 0; i < phnum; i += 1) {
    const ph = phoff + i * phentsize;
    if (v.getUint32(ph, true) !== 2) {
      continue;
    }
    const poff = Number(v.getBigUint64(ph + 0x08, true));
    const psz = Number(v.getBigUint64(ph + 0x20, true));
    for (let d = poff; d + 16 <= poff + psz; d += 16) {
      const tag = v.getBigInt64(d, true);
      if (tag === 0n) {
        break;
      }
      if (tag === 0x6fffffffn) {
        return d + 8;
      }
    }
  }
  throw new Error("fixture has no DT_VERNEEDNUM");
}

describe("versionNeeds", () => {
  test("glibc 2.28 x86_64: libc.so.6 needs 2.28 and 2.2.5", () => {
    const needs = versionNeeds(X86);
    expect(needs).toContainEqual({ file: "libc.so.6", name: "GLIBC_2.28" });
    expect(needs).toContainEqual({ file: "libc.so.6", name: "GLIBC_2.2.5" });
  });

  test("glibc 2.39 aarch64: libc.so.6 needs 2.39, 2.36, 2.34, 2.17", () => {
    const needs = versionNeeds(ARM);
    expect(needs).toContainEqual({ file: "libc.so.6", name: "GLIBC_2.39" });
    expect(needs).toContainEqual({ file: "libc.so.6", name: "GLIBC_2.36" });
    expect(needs).toContainEqual({ file: "libc.so.6", name: "GLIBC_2.34" });
    expect(needs).toContainEqual({ file: "libc.so.6", name: "GLIBC_2.17" });
  });

  test("static musl has no version needs", () => {
    expect(versionNeeds(MUSL)).toStrictEqual([]);
  });
});

describe("glibcFloor", () => {
  test("2.28 and 2.39 fixtures report their floor", () => {
    expect(glibcFloor(X86)).toBe("2.28");
    expect(glibcFloor(ARM)).toBe("2.39");
  });

  test("static musl has no floor", () => {
    expect(glibcFloor(MUSL)).toBeUndefined();
  });

  test("GLIBC_PRIVATE-style names do not count", () => {
    const { buf, hits } = patchName(ARM, "GLIBC_2.39", "GLIBC_PRIV");
    expect(hits).toBeGreaterThan(0);
    expect(glibcFloor(buf)).toBe(expectedFloor(ARM, "2.39"));
  });

  test("weak version needs count toward the floor", () => {
    // VER_FLG_WEAK is vna_flags (u16, four bytes past vna_hash).
    const out = new Uint8Array(ARM);
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(
      vernauxOff(ARM, HASH_GLIBC_239) + 4,
      0x2,
      true,
    );
    expect(glibcFloor(out)).toBe("2.39");
  });

  test("a corrupt DT_VERNEEDNUM is rejected", () => {
    const out = new Uint8Array(ARM);
    new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(
      verneedNumOff(ARM),
      BigInt(ARM.length),
      true,
    );
    expect(() => versionNeeds(out)).toThrow(/malformed/);
  });
});

describe("header validation", () => {
  test.each<[string, Uint8Array, RegExp]>([
    ["bad magic", patched(X86, 0, 0), /not an ELF file/],
    ["EI_CLASS 1", patched(X86, 4, 1), /32-bit ELF is not supported/],
    ["EI_DATA 2", patched(X86, 5, 2), /big-endian ELF is not supported/],
    ["EI_VERSION 0", patched(X86, 6, 0), /EI_VERSION/],
    ["e_phentsize 55", patched(X86, 0x36, 55), /e_phentsize/],
  ])("rejects %s", (_label, buf, re) => {
    expect(() => versionNeeds(buf)).toThrow(re);
    expect(() => versionNeeds(buf)).toThrow(ElfError);
  });

  test("a non-ELF buffer is rejected", () => {
    const buf = new TextEncoder().encode("this is not an ELF binary at all");
    expect(() => versionNeeds(buf)).toThrow(/not an ELF file/);
  });
});

describe("truncation", () => {
  const truncations = (buf: Uint8Array): number[] => [
    0,
    4,
    16,
    63,
    64,
    65,
    Math.floor(buf.length / 2),
    buf.length - 1,
  ];

  test.each<[string, Uint8Array, number]>([
    ...truncations(X86).map((at): [string, Uint8Array, number] => ["x86_64", X86, at]),
    ...truncations(ARM).map((at): [string, Uint8Array, number] => ["aarch64", ARM, at]),
  ])("%s truncated at %i", (_label, buf, at) => {
    expect(() => versionNeeds(buf.slice(0, at))).toThrow(/truncated/);
  });
});
