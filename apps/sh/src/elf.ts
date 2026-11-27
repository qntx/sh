// Minimal ELF64 reader for the sync-time glibc floor: the highest
// GLIBC_x.y version a dynamically linked binary needs, parsed through the
// program headers (what the loader uses) so stripped binaries still yield
// it. Every offset and address the file supplies is bounds-checked.

export class ElfError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ElfError";
  }
}

export type VersionNeed = { file: string; name: string };

const PT_LOAD = 1n;
const PT_DYNAMIC = 2n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;
const ELF_HEADER_SIZE = 64;
const PHENTSIZE = 56;
const GLIBC_NAME_RE = /^GLIBC_(\d+(?:\.\d+)+)$/;

function truncated(what: string): never {
  throw new ElfError(`truncated: ${what}`);
}

function malformed(what: string): never {
  throw new ElfError(`malformed: ${what}`);
}

function num(v: bigint, what: string): number {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) {
    malformed(`${what} does not fit a safe integer`);
  }
  return Number(v);
}

// Bounds-checked little-endian access; any read past the buffer is a
// truncation, never a RangeError or a garbage decode.
class Reader {
  private readonly view: DataView;

  constructor(buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(off: number): number {
    if (off < 0 || off + 1 > this.view.byteLength) {
      truncated(`byte at offset ${off}`);
    }
    return this.view.getUint8(off);
  }

  u16(off: number): number {
    if (off < 0 || off + 2 > this.view.byteLength) {
      truncated(`u16 at offset ${off}`);
    }
    return this.view.getUint16(off, true);
  }

  u32(off: number): number {
    if (off < 0 || off + 4 > this.view.byteLength) {
      truncated(`u32 at offset ${off}`);
    }
    return this.view.getUint32(off, true);
  }

  u64(off: number): number {
    if (off < 0 || off + 8 > this.view.byteLength) {
      truncated(`u64 at offset ${off}`);
    }
    return num(this.view.getBigUint64(off, true), `u64 at offset ${off}`);
  }

  i64(off: number): bigint {
    if (off < 0 || off + 8 > this.view.byteLength) {
      truncated(`i64 at offset ${off}`);
    }
    return this.view.getBigInt64(off, true);
  }
}

type LoadSegment = { vaddr: number; filesz: number; offset: number };

// One NUL-terminated string inside [strtab, strtab + strsz).
function strAt(r: Reader, strtab: number, strsz: number, nameOff: number): string {
  if (nameOff >= strsz) {
    return malformed(`string offset ${nameOff} past .dynstr size ${strsz}`);
  }
  const bytes: number[] = [];
  for (let i = nameOff; i < strsz; i += 1) {
    const b = r.u8(strtab + i);
    if (b === 0) {
      return String.fromCodePoint(...bytes);
    }
    bytes.push(b);
  }
  return malformed(`unterminated string at .dynstr offset ${nameOff}`);
}

// Virtual address → file offset through the PT_LOAD mapping
// (p_vaddr <= a < p_vaddr + p_filesz).
function v2o(loads: LoadSegment[], addr: number, what: string): number {
  for (const l of loads) {
    if (addr >= l.vaddr && addr < l.vaddr + l.filesz) {
      return l.offset + (addr - l.vaddr);
    }
  }
  return malformed(`${what} address 0x${addr.toString(16)} is not in any PT_LOAD`);
}

// Every Verneed file's Vernaux entries ({file, name} per needed symbol
// version), or [] for binaries with no version needs: static, musl and
// static-pie binaries have no PT_DYNAMIC at all.
export function versionNeeds(buf: Uint8Array): VersionNeed[] {
  const r = new Reader(buf);
  if (r.u8(0) !== 0x7f || r.u8(1) !== 0x45 || r.u8(2) !== 0x4c || r.u8(3) !== 0x46) {
    throw new ElfError("not an ELF file");
  }
  const cls = r.u8(4);
  if (cls === 1) {
    throw new ElfError("32-bit ELF is not supported");
  }
  if (cls !== 2) {
    malformed(`unknown ELF class ${cls}`);
  }
  const data = r.u8(5);
  if (data === 2) {
    throw new ElfError("big-endian ELF is not supported");
  }
  if (data !== 1) {
    malformed(`unknown ELF data encoding ${data}`);
  }
  if (r.u8(6) !== 1) {
    malformed(`unsupported EI_VERSION ${r.u8(6)}`);
  }
  if (buf.byteLength < ELF_HEADER_SIZE) {
    truncated("ELF64 header");
  }

  const phoff = r.u64(0x20);
  const shoff = r.u64(0x28);
  const phentsize = r.u16(0x36);
  const phnum = r.u16(0x38);
  const shentsize = r.u16(0x3a);
  const shnum = r.u16(0x3c);

  if (phentsize !== PHENTSIZE) {
    malformed(`e_phentsize ${phentsize}, expected ${PHENTSIZE}`);
  }
  if (phoff + phnum * phentsize > buf.byteLength) {
    truncated("program header table");
  }
  if (shoff !== 0 && shoff + shnum * shentsize > buf.byteLength) {
    truncated("section header table");
  }

  const loads: LoadSegment[] = [];
  let dynOff = -1;
  let dynSize = 0;
  for (let i = 0; i < phnum; i += 1) {
    const off = phoff + i * phentsize;
    const type = r.u32(off);
    const pOffset = r.u64(off + 0x08);
    const pVaddr = r.u64(off + 0x10);
    const pFilesz = r.u64(off + 0x20);
    if (pOffset + pFilesz > buf.byteLength) {
      truncated(`segment ${i} contents`);
    }
    if (type === Number(PT_LOAD)) {
      loads.push({ vaddr: pVaddr, filesz: pFilesz, offset: pOffset });
    }
    if (type === Number(PT_DYNAMIC)) {
      dynOff = pOffset;
      dynSize = pFilesz;
    }
  }
  if (dynOff < 0) {
    return [];
  }

  let strtab: number | undefined;
  let strsz: number | undefined;
  let verneed: number | undefined;
  let verneedNum = 0;
  for (let off = dynOff; off + 16 <= dynOff + dynSize; off += 16) {
    const tag = r.i64(off);
    const val = r.u64(off + 8);
    if (tag === 0n) {
      break;
    }
    if (tag === DT_STRTAB) {
      strtab = v2o(loads, val, "DT_STRTAB");
    } else if (tag === DT_STRSZ) {
      strsz = val;
    } else if (tag === DT_VERNEED) {
      verneed = v2o(loads, val, "DT_VERNEED");
    } else if (tag === DT_VERNEEDNUM) {
      verneedNum = val;
    }
  }
  if (verneed === undefined) {
    return [];
  }
  // Each Verneed is 16 bytes and lives inside the file, so the count
  // cannot exceed the file size — bounds the walk on corrupt input.
  if (verneedNum * 16 > buf.byteLength) {
    malformed(`DT_VERNEEDNUM ${verneedNum} exceeds the file size`);
  }
  if (strtab === undefined || strsz === undefined) {
    malformed("DT_VERNEED without DT_STRTAB/DT_STRSZ");
  }

  const needs: VersionNeed[] = [];
  let voff = verneed;
  for (let i = 0; i < verneedNum; i += 1) {
    if (r.u16(voff) !== 1) {
      malformed(`Verneed ${i}: vn_version ${r.u16(voff)}, expected 1`);
    }
    const vnCnt = r.u16(voff + 2);
    const vnFile = r.u32(voff + 4);
    const vnAux = r.u32(voff + 8);
    const vnNext = r.u32(voff + 12);
    const file = strAt(r, strtab, strsz, vnFile);
    let aoff = voff + vnAux;
    for (let j = 0; j < vnCnt; j += 1) {
      const vnaName = r.u32(aoff + 8);
      const vnaNext = r.u32(aoff + 12);
      needs.push({ file, name: strAt(r, strtab, strsz, vnaName) });
      if (j + 1 < vnCnt && vnaNext === 0) {
        malformed(`Verneed ${i}: vna_next is 0 before vn_cnt entries`);
      }
      aoff += vnaNext;
    }
    if (i + 1 < verneedNum && vnNext === 0) {
      malformed(`Verneed ${i}: vn_next is 0 before DT_VERNEEDNUM entries`);
    }
    voff += vnNext;
  }
  return needs;
}

// The highest GLIBC_x.y the binary needs, as "MAJOR.MINOR": every Vernaux
// name matching GLIBC_<n>(.<n>)+ across all needed files, weak needs
// included (the same rule as qntx/workflows' glibc-floor check). Extra
// components fold into the compare but only the first two are reported
// ("2.2.5" -> "2.2"). undefined when the binary needs no GLIBC version.
export function glibcFloor(buf: Uint8Array): string | undefined {
  let best: number[] | undefined;
  for (const { name } of versionNeeds(buf)) {
    const m = GLIBC_NAME_RE.exec(name);
    if (m === null) {
      continue;
    }
    const parts = (m[1] ?? "").split(".").map(Number);
    let cmp = 1;
    if (best !== undefined) {
      cmp = 0;
      const n = Math.max(parts.length, best.length);
      for (let i = 0; i < n && cmp === 0; i += 1) {
        cmp = (parts[i] ?? 0) - (best[i] ?? 0);
      }
    }
    if (cmp > 0) {
      best = parts;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  return `${best[0] ?? 0}.${best[1] ?? 0}`;
}
