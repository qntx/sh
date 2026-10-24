// SKILL.md validation per agentskills.io/specification. Pure — no I/O.

import { parseDocument } from "yaml";

import { isObj } from "./select.ts";

export const NAME_RE: RegExp = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_FILE = 256 * 1024;
const MAX_DESC = 1024;
const MAX_COMPAT = 500;
const FM_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export type Frontmatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
};

export type Skill = {
  fm: Frontmatter;
  body: string;
};

export function fail(msg: string): never {
  throw new Error(msg);
}

// Byte-level checks that must precede any decoding.
function checkBytes(name: string, bytes: Uint8Array): string {
  if (bytes.length === 0) {
    fail(`${name}: empty file`);
  }
  if (bytes.length > MAX_FILE) {
    fail(`${name}: exceeds ${MAX_FILE} bytes`);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${name}: UTF-8 BOM is not allowed`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text;
}

export function validateSkill(dirName: string, bytes: Uint8Array): Skill {
  const text = checkBytes(dirName, bytes);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (m === null) {
    fail(`${dirName}: must start with a '---' YAML frontmatter block closed by '---'`);
  }
  const doc = parseDocument(m[1] ?? "", { uniqueKeys: true });
  if (doc.errors.length > 0) {
    fail(`${dirName}: YAML frontmatter error: ${doc.errors[0]?.message ?? "unknown"}`);
  }
  const raw: unknown = doc.toJS();
  if (!isObj(raw)) {
    fail(`${dirName}: frontmatter must be a mapping`);
  }
  const fm = raw;
  for (const k of Object.keys(fm)) {
    if (!FM_KEYS.has(k)) {
      fail(`${dirName}: unknown frontmatter key "${k}"`);
    }
  }

  const { name } = fm;
  if (typeof name !== "string" || name.length === 0 || name.length > 64 || !NAME_RE.test(name)) {
    fail(`${dirName}: name must match ${NAME_RE} and be 1-64 chars`);
  }
  if (name !== dirName) {
    fail(`${dirName}: name "${name}" does not match the directory name`);
  }
  const { description } = fm;
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    description.trim().length > MAX_DESC
  ) {
    fail(`${dirName}: description must be a string of 1-${MAX_DESC} chars`);
  }
  const { license } = fm;
  if (license !== undefined && typeof license !== "string") {
    fail(`${dirName}: license must be a string`);
  }
  const { compatibility } = fm;
  if (
    compatibility !== undefined &&
    (typeof compatibility !== "string" ||
      compatibility.length === 0 ||
      compatibility.length > MAX_COMPAT)
  ) {
    fail(`${dirName}: compatibility must be a string of 1-${MAX_COMPAT} chars`);
  }
  const { metadata } = fm;
  const md: Record<string, string> = {};
  if (metadata !== undefined) {
    if (!isObj(metadata)) {
      fail(`${dirName}: metadata must be a mapping of string to string`);
    }
    for (const [k, v] of Object.entries(metadata)) {
      if (typeof v !== "string") {
        fail(`${dirName}: metadata."${k}" must be a string`);
      }
      md[k] = v;
    }
  }
  const allowedTools = fm["allowed-tools"];
  if (allowedTools !== undefined && typeof allowedTools !== "string") {
    fail(`${dirName}: allowed-tools must be a string`);
  }
  const body = m[2] ?? "";
  if (body.trim().length === 0) {
    fail(`${dirName}: body is empty`);
  }
  return {
    fm: {
      name,
      description,
      ...(typeof license === "string" ? { license } : {}),
      ...(typeof compatibility === "string" ? { compatibility } : {}),
      ...(metadata === undefined ? {} : { metadata: md }),
      ...(typeof allowedTools === "string" ? { allowedTools } : {}),
    },
    body,
  };
}
