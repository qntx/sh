// Cloudflare Worker: install-script proxy for qntx GitHub projects.
// Domain: sh.qntx.fun
//
// Routes:
//   /            → install.sh   (default repo: ovo)
//   /ps          → install.ps1
//   /{repo}      → install.sh
//   /{repo}/ps   → install.ps1
//
// Resolution:
//   1. If the target repo has its own install.{sh,ps1} at main, serve it as-is.
//   2. Otherwise serve this repo's template with __REPO__ / __BIN__ substituted.
//      BIN defaults to the repo name; override by placing a single-line
//      `install.bin` at the repo root.
//
// Examples:
//   curl -fsSL https://sh.qntx.fun | sh
//   curl -fsSL https://sh.qntx.fun/xmtp | sh
//   irm  https://sh.qntx.fun/xmtp/ps | iex

const ORGS = Object.freeze({ labs: "qntx-labs" });
const DEFAULT_ORG = "qntx";
const DEFAULT_REPO = "ovo";
const TEMPLATE_REPO = "qntx/sh";
const RAW_BASE = "https://raw.githubusercontent.com";
const CACHE_TTL = 3600;
const UPSTREAM_TIMEOUT_MS = 10_000;
const UPSTREAM_FAILURE_STATUS = 599;
const REPO_RE = /^[a-z\d](?:[a-z\d._-]*[a-z\d])?$/i;

const BASE_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
  "referrer-policy": "no-referrer",
});

/**
 * @typedef {{ org: string, repo: string, ps: boolean }} Route
 */

/**
 * Parse a URL pathname into a route descriptor.
 * @param {string} pathname
 * @returns {Route | null} null if the path is not a valid install route
 */
function parseRoute(pathname) {
  const seg = pathname.split("/").filter(Boolean);
  const ps = seg.at(-1) === "ps";
  if (ps) seg.pop();

  const org = ORGS[seg[0]] ? ORGS[seg.shift()] : DEFAULT_ORG;

  if (seg.length > 1) return null;

  const repo = seg[0] ?? DEFAULT_REPO;
  if (!REPO_RE.test(repo)) return null;

  return { org, repo, ps };
}

/**
 * Fetch a file from GitHub raw with edge caching and a timeout. Network or
 * timeout errors are normalized to a synthetic 599 response so callers can
 * treat every failure uniformly via status code.
 * @param {string} path repo-relative path, e.g. "qntx/foo/main/install.sh"
 * @returns {Promise<Response>}
 */
async function rawFetch(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(`${RAW_BASE}/${path}`, {
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      signal: ctrl.signal,
    });
  } catch (err) {
    console.error("upstream fetch failed", { path, err });
    return new Response(null, { status: UPSTREAM_FAILURE_STATUS });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {BodyInit | null} body
 * @param {number} status
 * @param {Record<string, string>} [extra]
 */
function textResponse(body, status, extra) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control":
        status === 200 ? `public, max-age=${CACHE_TTL}` : "no-store",
      ...BASE_HEADERS,
      ...extra,
    },
  });
}

function notFound() {
  return textResponse("Not found\n", 404);
}

function badGateway() {
  return textResponse("Upstream error\n", 502);
}

function internalError() {
  return textResponse("Internal server error\n", 500);
}

function methodNotAllowed() {
  return textResponse("Method not allowed\n", 405, { allow: "GET, HEAD" });
}

/**
 * Substitute template placeholders.
 * @param {string} template
 * @param {{ repo: string, bin: string }} vars
 */
function render(template, { repo, bin }) {
  return template.replaceAll("__REPO__", repo).replaceAll("__BIN__", bin);
}

/**
 * Produce the install-script response for a parsed route.
 * @param {Route} route
 * @returns {Promise<Response>}
 */
async function resolveScript(route) {
  const { org, repo, ps } = route;
  const ext = ps ? "ps1" : "sh";
  const repoPath = `${org}/${repo}`;
  const isTemplate = repoPath === TEMPLATE_REPO;

  if (!isTemplate) {
    const custom = await rawFetch(`${repoPath}/main/install.${ext}`);
    if (custom.ok) return textResponse(custom.body, 200);
    if (custom.status !== 404) return badGateway();
  }

  const [tmplResp, binResp] = await Promise.all([
    rawFetch(`${TEMPLATE_REPO}/main/install.${ext}`),
    isTemplate ? null : rawFetch(`${repoPath}/main/install.bin`),
  ]);
  if (!tmplResp.ok) return badGateway();

  let bin = repo;
  if (binResp?.ok) {
    const trimmed = (await binResp.text()).trim();
    if (trimmed) bin = trimmed;
  } else if (binResp && binResp.status !== 404) {
    return badGateway();
  }

  const body = render(await tmplResp.text(), { repo: repoPath, bin });
  return textResponse(body, 200);
}

/**
 * @param {Request} request
 */
async function handle(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }
  const route = parseRoute(new URL(request.url).pathname);
  if (!route) return notFound();

  const resp = await resolveScript(route);
  return request.method === "HEAD"
    ? new Response(null, { status: resp.status, headers: resp.headers })
    : resp;
}

export default {
  /** @param {Request} request */
  async fetch(request) {
    try {
      return await handle(request);
    } catch (err) {
      console.error("unhandled error", { err });
      return internalError();
    }
  },
};
