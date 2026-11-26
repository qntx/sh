// Release-asset contract: vendored copy of qntx/workflows
// contract/release-assets.json (plus the `layout` member proposed
// upstream), loaded from apps/sh/contract/release-assets.json. Keep the
// two files byte-identical. TARGETS, the variant pattern, and the
// archive layout all derive from it — there is no other definition.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isRecord } from "@qntx/sync";

export type ValidExample = {
  bin: string;
  version: string;
  name: string;
  kind: string;
  target?: string;
  variant?: string;
};

export type NamedExample = { bin: string; version: string; name: string; reason: string };

export type Contract = {
  targets: ReadonlyArray<{ triple: string; archive: "tar.gz" | "zip" }>;
  variantPattern: string;
  layout: { "tar.gz": readonly [string, string]; zip: readonly [string, string] };
  examples: {
    valid: ValidExample[];
    ignored: NamedExample[];
    invalid: NamedExample[];
  };
};

function fail(msg: string): never {
  throw new Error(`contract: ${msg}`);
}

function stringArray(field: string, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((v) => typeof v === "string")) {
    fail(`${field} must be a non-empty string array`);
  }
  return raw;
}

function memberPair(field: string, raw: unknown): [string, string] {
  const members = stringArray(field, raw);
  if (members.length !== 2) {
    fail(`${field} must list exactly two templates`);
  }
  return [members[0] ?? "", members[1] ?? ""];
}

function exampleBase(
  field: string,
  e: unknown,
): { rec: Record<string, unknown>; bin: string; version: string; name: string } {
  if (!isRecord(e)) {
    fail(`examples.${field}: entries must be objects`);
  }
  const { bin, version, name } = e;
  if (typeof bin !== "string" || typeof version !== "string" || typeof name !== "string") {
    fail(`examples.${field}: bin, version and name must be strings`);
  }
  return { rec: e, bin, version, name };
}

function validExamples(raw: unknown): ValidExample[] {
  if (!Array.isArray(raw)) {
    fail("examples.valid must be an array");
  }
  return raw.map((e) => {
    const { rec: base, bin, version, name } = exampleBase("valid", e);
    const { kind, target, variant } = base;
    if (typeof kind !== "string") {
      fail(`examples.valid ${name}: kind must be a string`);
    }
    if (target !== undefined && typeof target !== "string") {
      fail(`examples.valid ${name}: target must be a string`);
    }
    if (variant !== null && typeof variant !== "string") {
      fail(`examples.valid ${name}: variant must be a string or null`);
    }
    const out: ValidExample = { bin, version, name, kind };
    // JSON null becomes an absent optional member.
    if (variant !== null && variant !== undefined) {
      out.variant = variant;
    }
    if (target !== undefined) {
      out.target = target;
    }
    return out;
  });
}

function namedExamples(field: string, raw: unknown): NamedExample[] {
  if (!Array.isArray(raw)) {
    fail(`examples.${field} must be an array`);
  }
  return raw.map((e) => {
    const { rec: base, bin, version, name } = exampleBase(field, e);
    const { reason } = base;
    if (typeof reason !== "string") {
      fail(`examples.${field} ${name}: reason must be a string`);
    }
    return { bin, version, name, reason };
  });
}

// Strict parse of the parts we consume; unknown members are tolerated
// (the contract is allowed to grow), bad shapes fail loudly at load.
export function parseContract(raw: unknown): Contract {
  if (!isRecord(raw)) {
    fail("root must be an object");
  }
  const { targets, patterns, layout, examples: ex } = raw;
  if (!Array.isArray(targets) || targets.length === 0) {
    fail("targets must be a non-empty array");
  }
  const parsedTargets: Array<{ triple: string; archive: "tar.gz" | "zip" }> = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (!isRecord(t)) {
      fail("targets entries must be objects");
    }
    const { triple, archive } = t;
    if (typeof triple !== "string" || triple === "") {
      fail("targets entries need a non-empty triple string");
    }
    if (seen.has(triple)) {
      fail(`duplicate target triple "${triple}"`);
    }
    seen.add(triple);
    if (archive !== "tar.gz" && archive !== "zip") {
      fail(`target "${triple}": archive must be tar.gz or zip`);
    }
    parsedTargets.push({ triple, archive });
  }
  if (!isRecord(patterns) || typeof patterns["variant"] !== "string") {
    fail("patterns.variant must be a string");
  }
  const variantPattern = patterns["variant"];
  if (!isRecord(layout) || !isRecord(layout["members"])) {
    fail("layout.members must be an object");
  }
  const { members } = layout;
  if (!isRecord(ex)) {
    fail("examples must be an object");
  }
  return {
    targets: parsedTargets,
    variantPattern,
    layout: {
      "tar.gz": memberPair('layout.members["tar.gz"]', members["tar.gz"]),
      zip: memberPair('layout.members["zip"]', members["zip"]),
    },
    examples: {
      valid: validExamples(ex["valid"]),
      ignored: namedExamples("ignored", ex["ignored"]),
      invalid: namedExamples("invalid", ex["invalid"]),
    },
  };
}

const CONTRACT_PATH = fileURLToPath(new URL("../contract/release-assets.json", import.meta.url));
const contract = parseContract(JSON.parse(readFileSync(CONTRACT_PATH, "utf8")));

// Every target triple release-rust can emit, in contract order. The
// single source of truth for sync, build and templates.
export const TARGETS: ReadonlyArray<string> = contract.targets.map((t) => t.triple);
export type Target = string;

const ARCHIVE_BY_TARGET = new Map(contract.targets.map((t) => [t.triple, t.archive]));

export function archiveExt(target: string): "tar.gz" | "zip" {
  const ext = ARCHIVE_BY_TARGET.get(target);
  if (ext === undefined) {
    fail(`archiveExt: unknown target "${target}"`);
  }
  return ext;
}

// The targets whose binaries link glibc dynamically and therefore carry
// a measured floor in the lock.
export function isGlibcTarget(t: string): boolean {
  return t.endsWith("-linux-gnu");
}

export const VARIANT_RE: RegExp = new RegExp(contract.variantPattern);

export const examples: Contract["examples"] = contract.examples;

// The two member names the contract allows inside an archive:
// flat (`./<bin>` / `<bin>.exe`) then nested (`<stem>/<bin>`).
export function layoutMembers(
  target: string,
  bin: string,
  stem: string,
): readonly [flat: string, nested: string] {
  const [flat, nested] = contract.layout[archiveExt(target)];
  const sub = (t: string): string => t.replaceAll("<bin>", bin).replaceAll("<stem>", stem);
  return [sub(flat), sub(nested)];
}
