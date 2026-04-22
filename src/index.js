// Cloudflare Worker: install-script proxy for qntx GitHub projects.
// Domain: sh.qntx.fun
//
// Routes:
//   /            → install.sh   (default repo: machi)
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

const ORGS = { labs: "qntx-labs" };
const DEFAULT_ORG = "qntx";
const DEFAULT_REPO = "machi";
const TEMPLATE_REPO = "qntx/sh";
const RAW = "https://raw.githubusercontent.com";
const CACHE_TTL = 3600;
const REPO_RE = /^[a-z\d](?:[a-z\d._-]*[a-z\d])?$/i;

function resolve(pathname) {
  const seg = pathname.split("/").filter(Boolean);
  const ps = seg.at(-1) === "ps";
  if (ps) seg.pop();

  const org = ORGS[seg[0]] ? ORGS[seg.shift()] : DEFAULT_ORG;

  if (seg.length > 1) return null;

  const repo = seg[0] ?? DEFAULT_REPO;
  if (!REPO_RE.test(repo)) return null;

  return { org, repo, ps };
}

function rawFetch(path) {
  return fetch(`${RAW}/${path}`, { cf: { cacheTtl: CACHE_TTL } });
}

function respond(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL}`,
    },
  });
}

export default {
  async fetch(request) {
    const ctx = resolve(new URL(request.url).pathname);
    if (!ctx) return new Response("Not found\n", { status: 404 });

    const { org, repo, ps } = ctx;
    const ext = ps ? "ps1" : "sh";
    const repoPath = `${org}/${repo}`;
    const isTemplate = repoPath === TEMPLATE_REPO;

    if (!isTemplate) {
      const custom = await rawFetch(`${repoPath}/main/install.${ext}`);
      if (custom.ok) return respond(await custom.text());
    }

    const [tmplResp, binResp] = await Promise.all([
      rawFetch(`${TEMPLATE_REPO}/main/install.${ext}`),
      isTemplate ? null : rawFetch(`${repoPath}/main/install.bin`),
    ]);
    if (!tmplResp.ok) return new Response("Not found\n", { status: 404 });

    const override = binResp?.ok && (await binResp.text()).trim();
    const bin = override || repo;

    const body = (await tmplResp.text())
      .replaceAll("__REPO__", repoPath)
      .replaceAll("__BIN__", bin);

    return respond(body);
  },
};
