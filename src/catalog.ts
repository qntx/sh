// Catalog and lock-file validation. No schema library: small strict
// validators that reject unknown fields and bad shapes.

export const KEY_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const PACKAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const ENV_PREFIX_RE = /^[A-Z0-9_]+$/;
export const RESERVED_KEYS = new Set(["index", "ps"]);

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
const TARGET_SET = new Set<string>(TARGETS);

export type ToolSpec = {
  repo: string;
  package?: string;
  installer: "template" | "repo";
};

export type Catalog = Record<string, ToolSpec>;

export type LockEntry = {
  version: string;
  tag: string;
  commit: string;
  immutable: boolean;
  description: string;
  assets: Record<string, string>;
  installer?: { sh: string; ps1: string };
};

export type Releases = Record<string, LockEntry>;

function fail(msg: string): never {
  throw new Error(msg);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const CATALOG_FIELDS = new Set(["repo", "package", "installer"]);

function parseTool(key: string, raw: unknown): ToolSpec {
  if (!isObject(raw)) {
    fail(`catalog ${key}: entry must be an object`);
  }
  for (const f of Object.keys(raw)) {
    if (!CATALOG_FIELDS.has(f)) {
      fail(`catalog ${key}: unknown field "${f}"`);
    }
  }
  const { repo, package: pkg, installer } = raw;
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    fail(`catalog ${key}: repo must match ${REPO_RE}`);
  }
  if (pkg !== undefined && (typeof pkg !== "string" || !PACKAGE_RE.test(pkg))) {
    fail(`catalog ${key}: package must match ${PACKAGE_RE}`);
  }
  if (installer !== undefined && installer !== "template" && installer !== "repo") {
    fail(`catalog ${key}: installer must be "template" or "repo"`);
  }
  const spec: ToolSpec = { repo, installer: installer ?? "template" };
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

const LOCK_FIELDS = new Set([
  "version",
  "tag",
  "commit",
  "immutable",
  "description",
  "assets",
  "installer",
]);

export function sanitizeDescription(key: string, raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  // Safe printable subset: reject control chars and shell-significant bytes.
  if (/[^ -~]/.test(s) || /["'`\\$]/.test(s)) {
    fail(`releases ${key}: description contains unsafe characters`);
  }
  return s;
}

export function parseLockEntry(key: string, raw: unknown): LockEntry {
  if (!isObject(raw)) {
    fail(`releases ${key}: entry must be an object`);
  }
  for (const f of Object.keys(raw)) {
    if (!LOCK_FIELDS.has(f)) {
      fail(`releases ${key}: unknown field "${f}"`);
    }
  }
  const { version, tag, commit, immutable, description, assets, installer } = raw;
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    fail(`releases ${key}: version must match ${VERSION_RE}`);
  }
  if (typeof tag !== "string" || tag !== `v${version}`) {
    fail(`releases ${key}: tag must be "v${version}"`);
  }
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) {
    fail(`releases ${key}: commit must match ${COMMIT_RE}`);
  }
  if (typeof immutable !== "boolean") {
    fail(`releases ${key}: immutable must be a boolean`);
  }
  const desc = sanitizeDescription(key, description);
  if (!isObject(assets) || Object.keys(assets).length === 0) {
    fail(`releases ${key}: assets must be a non-empty object`);
  }
  const assetMap: Record<string, string> = {};
  for (const [t, h] of Object.entries(assets)) {
    if (!TARGET_SET.has(t)) {
      fail(`releases ${key}: unknown target "${t}"`);
    }
    if (typeof h !== "string" || !SHA256_RE.test(h)) {
      fail(`releases ${key}: asset hash for "${t}" must match ${SHA256_RE}`);
    }
    assetMap[t] = h;
  }
  const entry: LockEntry = {
    version,
    tag,
    commit,
    immutable,
    description: desc,
    assets: assetMap,
  };
  if (installer !== undefined) {
    if (!isObject(installer)) {
      fail(`releases ${key}: installer must be an object`);
    }
    for (const f of Object.keys(installer)) {
      if (f !== "sh" && f !== "ps1") {
        fail(`releases ${key}.installer: unknown field "${f}"`);
      }
    }
    const { sh, ps1 } = installer;
    if (typeof sh !== "string" || !SHA256_RE.test(sh)) {
      fail(`releases ${key}.installer.sh: must match ${SHA256_RE}`);
    }
    if (typeof ps1 !== "string" || !SHA256_RE.test(ps1)) {
      fail(`releases ${key}.installer.ps1: must match ${SHA256_RE}`);
    }
    entry.installer = { sh, ps1 };
  }
  return entry;
}

export function parseReleases(raw: unknown): Releases {
  if (!isObject(raw)) {
    fail("releases: root must be an object");
  }
  const releases: Releases = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!KEY_RE.test(key)) {
      fail(`releases key "${key}": must match ${KEY_RE}`);
    }
    releases[key] = parseLockEntry(key, entry);
  }
  return releases;
}

export function envPrefix(tool: string): string {
  return tool.toUpperCase().replaceAll("-", "_");
}
