// Catalog and lock-file validation. No schema library: small strict
// validators that reject unknown fields and bad shapes.

export const KEY_RE: RegExp = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const REPO_RE: RegExp = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const PACKAGE_RE: RegExp = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const SHA256_RE: RegExp = /^[0-9a-f]{64}$/;
export const ENV_PREFIX_RE: RegExp = /^[A-Z0-9_]+$/;
export const RESERVED_KEYS: ReadonlySet<string> = new Set(["index", "ps"]);

// Every target triple release-rust can emit, including the opt-in musl
// builds. The single source of truth for sync, build and templates.
export const TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
] as const;
export type Target = (typeof TARGETS)[number];

export type ToolSpec = {
  repo: string;
  package?: string;
};

export type Catalog = Record<string, ToolSpec>;

function fail(msg: string): never {
  throw new Error(msg);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const CATALOG_FIELDS = new Set(["repo", "package"]);

function parseTool(key: string, raw: unknown): ToolSpec {
  if (!isObject(raw)) {
    fail(`catalog ${key}: entry must be an object`);
  }
  for (const f of Object.keys(raw)) {
    if (!CATALOG_FIELDS.has(f)) {
      fail(`catalog ${key}: unknown field "${f}"`);
    }
  }
  const { repo, package: pkg } = raw;
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    fail(`catalog ${key}: repo must match ${REPO_RE}`);
  }
  if (pkg !== undefined && (typeof pkg !== "string" || !PACKAGE_RE.test(pkg))) {
    fail(`catalog ${key}: package must match ${PACKAGE_RE}`);
  }
  const spec: ToolSpec = { repo };
  if (pkg !== undefined) {
    spec.package = pkg;
  }
  return spec;
}

export function parseCatalog(raw: unknown): Catalog {
  if (!isObject(raw)) {
    fail("catalog: root must be an object");
  }
  for (const f of Object.keys(raw)) {
    if (f !== "tools") {
      fail(`catalog: unknown field "${f}"`);
    }
  }
  const { tools } = raw;
  if (!isObject(tools)) {
    fail("catalog.tools: must be an object");
  }
  const catalog: Catalog = {};
  for (const [key, entry] of Object.entries(tools)) {
    if (!KEY_RE.test(key)) {
      fail(`catalog key "${key}": must match ${KEY_RE}`);
    }
    if (RESERVED_KEYS.has(key)) {
      fail(`catalog key "${key}": reserved name`);
    }
    catalog[key] = parseTool(key, entry);
  }
  if (Object.keys(catalog).length === 0) {
    fail("catalog.tools: empty");
  }
  return catalog;
}

export function sanitizeDescription(key: string, raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  // Safe printable subset: reject control chars and shell-significant bytes.
  if (/[^ -~]/.test(s) || /["'`\\$]/.test(s)) {
    fail(`releases ${key}: description contains unsafe characters`);
  }
  return s;
}

export function envPrefix(tool: string): string {
  return tool.toUpperCase().replaceAll("-", "_");
}
