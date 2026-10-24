// Minimal GitHub REST client for sync tooling. Authorization uses
// $GITHUB_TOKEN when set. Node-standard APIs only (runs under Bun and Node).

import { writeFileSync } from "node:fs";

const API = "https://api.github.com";
const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`GET ${url} -> HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  digest: string | undefined;
};

export type Release = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  assets: ReleaseAsset[];
};

export type Repo = {
  full_name: string;
  private: boolean;
  archived: boolean;
  description: string;
  default_branch: string;
};

export type Commit = {
  sha: string;
};

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "qntx-sh-sync",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token !== undefined && token !== "") {
    h["Authorization"] = `Bearer ${token}`;
  }
  return h;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Retry transient failures (network/TLS flakes, 5xx) with exponential
// backoff; 4xx and other terminal statuses fail immediately.
async function request(url: string, timeout = TIMEOUT_MS): Promise<Response> {
  /* oxlint-disable no-await-in-loop */
  for (let attempt = 1; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(timeout),
        redirect: "follow",
      });
    } catch (error) {
      if (attempt >= ATTEMPTS) {
        throw error;
      }
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) {
      return res;
    }
    if (res.status >= 500 && attempt < ATTEMPTS) {
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    throw new HttpError(res.status, url);
  }
  /* oxlint-enable no-await-in-loop */
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, k: string, what: string): string {
  const v = o[k];
  if (typeof v !== "string") {
    throw new TypeError(`${what}: missing string field ${k}`);
  }
  return v;
}

function bool(o: Record<string, unknown>, k: string, what: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") {
    throw new TypeError(`${what}: missing boolean field ${k}`);
  }
  return v;
}

export async function text(url: string): Promise<string> {
  const res = await request(url);
  return res.text();
}

export async function download(url: string, dest: string): Promise<void> {
  const res = await request(url, 120_000);
  writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
}

export async function repo(name: string): Promise<Repo> {
  const res = await request(`${API}/repos/${name}`);
  const raw: unknown = await res.json();
  if (!isObj(raw)) {
    throw new TypeError(`${name}: bad repo payload`);
  }
  const { description } = raw;
  return {
    full_name: str(raw, "full_name", name),
    private: bool(raw, "private", name),
    archived: bool(raw, "archived", name),
    description: typeof description === "string" ? description : "",
    default_branch: str(raw, "default_branch", name),
  };
}

function parseRelease(raw: unknown, what: string): Release {
  if (!isObj(raw)) {
    throw new TypeError(`${what}: bad release payload`);
  }
  const rawAssets = raw["assets"];
  if (!Array.isArray(rawAssets)) {
    throw new TypeError(`${what}: release has no assets array`);
  }
  const assets: ReleaseAsset[] = rawAssets.map((a: unknown) => {
    if (!isObj(a)) {
      throw new TypeError(`${what}: bad asset entry`);
    }
    const { digest } = a;
    return {
      name: str(a, "name", what),
      browser_download_url: str(a, "browser_download_url", what),
      digest: typeof digest === "string" ? digest : undefined,
    };
  });
  const { immutable } = raw;
  return {
    tag_name: str(raw, "tag_name", what),
    draft: bool(raw, "draft", what),
    prerelease: bool(raw, "prerelease", what),
    immutable: typeof immutable === "boolean" ? immutable : false,
    assets,
  };
}

export async function releases(name: string): Promise<Release[]> {
  const out: Release[] = [];
  /* oxlint-disable no-await-in-loop */
  for (let page = 1; ; page += 1) {
    const res = await request(`${API}/repos/${name}/releases?per_page=100&page=${page}`);
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) {
      throw new TypeError(`${name}: bad releases payload`);
    }
    const chunk = raw.map((r) => parseRelease(r, name));
    out.push(...chunk);
    if (chunk.length < 100) {
      return out;
    }
  }
  /* oxlint-enable no-await-in-loop */
}

export async function commit(name: string, ref: string): Promise<Commit> {
  const res = await request(`${API}/repos/${name}/commits/${ref}`);
  const raw: unknown = await res.json();
  if (!isObj(raw)) {
    throw new TypeError(`${name}: bad commit payload`);
  }
  return { sha: str(raw, "sha", name) };
}

// File bytes at a ref via the contents API; undefined on 404.
export async function fileAtRef(
  name: string,
  path: string,
  ref: string,
): Promise<Uint8Array | undefined> {
  try {
    const res = await request(`${API}/repos/${name}/contents/${path}?ref=${ref}`);
    const raw: unknown = await res.json();
    if (!isObj(raw)) {
      throw new TypeError(`${name}: bad contents payload`);
    }
    const encoding = str(raw, "encoding", name);
    if (encoding !== "base64") {
      throw new Error(`${name}/${path}@${ref}: unexpected encoding ${encoding}`);
    }
    const bin = Buffer.from(str(raw, "content", name).replaceAll("\n", ""), "base64");
    return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

export type DirEntry = {
  name: string;
  type: string;
  path: string;
};

// List a directory's entries at a ref via the contents API.
export async function listDir(name: string, path: string, ref: string): Promise<DirEntry[]> {
  const res = await request(`${API}/repos/${name}/contents/${path}?ref=${ref}`);
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) {
    throw new TypeError(`${name}/${path}@${ref}: not a directory`);
  }
  return raw.map((e: unknown) => {
    if (!isObj(e)) {
      throw new TypeError(`${name}: bad dir entry`);
    }
    return {
      name: str(e, "name", name),
      type: str(e, "type", name),
      path: str(e, "path", name),
    };
  });
}
