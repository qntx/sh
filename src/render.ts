// Offline renderer: substitute the single `# @qntx-constants` marker line in
// a template with generated constant definitions. Fails when the marker is
// missing or duplicated, or any rendered value is unsafe.

import {
  ENV_PREFIX_RE,
  KEY_RE,
  PACKAGE_RE,
  REPO_RE,
  SHA256_RE,
  VERSION_RE,
  envPrefix,
} from "./catalog.ts";
import type { Catalog, LockEntry, Releases, ToolSpec } from "./catalog.ts";

export const MARKER = "# @qntx-constants";

export class RenderError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RenderError";
  }
}

function assert(re: RegExp, value: string, what: string): void {
  if (!re.test(value)) {
    throw new RenderError(`unsafe ${what}: ${JSON.stringify(value)}`);
  }
}

function checkCommon(tool: string, spec: ToolSpec, lock: LockEntry): string {
  assert(KEY_RE, tool, "tool");
  assert(REPO_RE, spec.repo, "repo");
  assert(VERSION_RE, lock.version, "version");
  const prefix = envPrefix(tool);
  assert(ENV_PREFIX_RE, prefix, "env prefix");
  const pkg = spec.package ?? "";
  if (pkg !== "") {
    assert(PACKAGE_RE, pkg, "package");
  }
  for (const [target, hash] of Object.entries(lock.assets)) {
    assert(SHA256_RE, hash, `sha256 for ${target}`);
  }
  return prefix;
}

export function renderSh(tool: string, spec: ToolSpec, lock: LockEntry): string {
  const prefix = checkCommon(tool, spec, lock);
  const lines = [
    `TOOL='${tool}'`,
    `REPO='${spec.repo}'`,
    `PACKAGE='${spec.package ?? ""}'`,
    `VERSION='${lock.version}'`,
    `ENV_PREFIX='${prefix}'`,
    `CFG_VERSION=\${${prefix}_VERSION-}`,
    `CFG_INSTALL_DIR=\${${prefix}_INSTALL_DIR-}`,
    `CFG_NO_MODIFY_PATH=\${${prefix}_NO_MODIFY_PATH-}`,
    "asset_sha256() {",
    '    case "$1" in',
  ];
  for (const [target, hash] of Object.entries(lock.assets)) {
    lines.push(`        ${target}) printf '%s' '${hash}' ;;`);
  }
  lines.push("        *) return 1 ;;", "    esac", "}");
  return lines.join("\n");
}

export function renderPs1(tool: string, spec: ToolSpec, lock: LockEntry): string {
  const prefix = checkCommon(tool, spec, lock);
  const lines = [
    `$Tool = '${tool}'`,
    `$Repo = '${spec.repo}'`,
    `$Package = '${spec.package ?? ""}'`,
    `$Version = '${lock.version}'`,
    `$EnvPrefix = '${prefix}'`,
    "$Sha256 = [ordered]@{",
  ];
  for (const [target, hash] of Object.entries(lock.assets)) {
    lines.push(`    '${target}' = '${hash}'`);
  }
  lines.push("}");
  return lines.join("\n");
}

// Rendered scripts must be pure ASCII: Windows PowerShell 5.1 decodes
// BOM-less files as ANSI, so any byte outside 0x09/0x0A/0x0D/0x20-0x7E
// would garble or break the script.
export function assertAscii(name: string, content: string): void {
  for (let i = 0; i < content.length; i += 1) {
    const c = content.codePointAt(i) ?? 0;
    if (c !== 9 && c !== 10 && c !== 13 && (c < 0x20 || c > 0x7e)) {
      throw new RenderError(
        `${name}: non-ASCII character U+${c.toString(16).padStart(4, "0")} at offset ${i}`,
      );
    }
  }
}

const MARKER_LINE_RE = /^\s*#\s*@qntx-constants\s*$/m;

export function substitute(template: string, constants: string): string {
  const hits = template.split("\n").filter((l) => MARKER_LINE_RE.test(l));
  if (hits.length === 0) {
    throw new RenderError(`marker "${MARKER}" missing`);
  }
  if (hits.length > 1) {
    throw new RenderError(`marker "${MARKER}" duplicated`);
  }
  const out = template.replace(/^.*@qntx-constants.*$/m, constants);
  if (out.includes("@qntx-constants")) {
    throw new RenderError("marker substitution left a stray marker");
  }
  return out;
}

// Tool list rows for index scripts — quoting stays in the render layer.
export function toolRows(
  catalog: Catalog,
  releases: Releases,
): Array<{ key: string; description: string }> {
  return Object.keys(catalog)
    .toSorted()
    .map((key) => {
      const lock = releases[key];
      if (lock === undefined) {
        throw new RenderError(`no lock entry for ${key}`);
      }
      return { key, description: lock.description };
    });
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", String.raw`'\''`)}'`;
}

export function renderIndexSh(catalog: Catalog, releases: Releases): string {
  const lines: string[] = [];
  for (const { key, description } of toolRows(catalog, releases)) {
    assert(/^[^\n]*$/, description, `description for ${key}`);
    lines.push(
      `    printf '  %-12s %s\\n' ${shQuote(key)} ${shQuote(description)} >&2`,
      `    printf '    curl -fsSL https://sh.qntx.org/%s | sh\\n' ${shQuote(key)} >&2`,
    );
  }
  return lines.join("\n");
}

export function renderIndexPs1(catalog: Catalog, releases: Releases): string {
  const lines: string[] = [];
  for (const { key, description } of toolRows(catalog, releases)) {
    const desc = description.replaceAll("'", "''");
    assert(/^[^\n]*$/, desc, `description for ${key}`);
    lines.push(
      `    [Console]::Error.WriteLine(('  {0,-12} {1}' -f '${key}', '${desc}'))`,
      `    [Console]::Error.WriteLine('    irm https://sh.qntx.org/${key}/ps | iex')`,
    );
  }
  return lines.join("\n");
}
