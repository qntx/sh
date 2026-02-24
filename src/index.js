// Cloudflare Worker: install-script proxy for qntx GitHub projects.
// Domain: sh.qntx.fun
//
// Routes:
//   /            → install.sh   (default: machi)
//   /ps          → install.ps1  (default: machi)
//   /{repo}      → install.sh
//   /{repo}/ps   → install.ps1
//
// Examples:
//   curl -fsSL https://sh.qntx.fun | sh
//   curl -fsSL https://sh.qntx.fun/xmtp | sh
//   irm  https://sh.qntx.fun/xmtp/ps | iex

const ORG = "qntx";
const DEFAULT_REPO = "machi";
const RAW = "https://raw.githubusercontent.com";
const CACHE_TTL = 3600;
const REPO_RE = /^[a-z\d](?:[a-z\d._-]*[a-z\d])?$/i;

function resolve(pathname) {
  const seg = pathname.split("/").filter(Boolean);
  const ps = seg.at(-1) === "ps";
  if (ps) seg.pop();

  if (seg.length > 1) return null;

  const repo = seg[0] ?? DEFAULT_REPO;
  if (!REPO_RE.test(repo)) return null;

  return `${RAW}/${ORG}/${repo}/main/install.${ps ? "ps1" : "sh"}`;
}

export default {
  async fetch(request) {
    const target = resolve(new URL(request.url).pathname);
    if (!target) return new Response("Not found\n", { status: 404 });

    const resp = await fetch(target, { cf: { cacheTtl: CACHE_TTL } });
    if (!resp.ok) return new Response("Not found\n", { status: 404 });

    return new Response(resp.body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL}`,
      },
    });
  },
};
