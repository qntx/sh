// Cloudflare Worker: universal install script proxy for GitHub projects.
// Custom domain: sh.qntx.fun
//
// Routing:
//   /                    → qntx/xmtp  install.sh   (default project)
//   /{repo}              → qntx/repo  install.sh   (qntx org shorthand)
//   /{repo}/ps           → qntx/repo  install.ps1
//   /{owner}/{repo}      → owner/repo install.sh   (any GitHub org)
//   /{owner}/{repo}/ps   → owner/repo install.ps1
//
// Usage:
//   curl -fsSL https://sh.qntx.fun | sh           # default (xmtp)
//   curl -fsSL https://sh.qntx.fun/xmtp | sh      # explicit
//   curl -fsSL https://sh.qntx.fun/user/repo | sh  # any GitHub project
//   irm https://sh.qntx.fun/xmtp/ps | iex          # Windows PowerShell

const DEFAULT_ORG = "qntx";
const DEFAULT_REPO = "xmtp";
const CACHE_TTL = 3600;

function resolve(pathname) {
  const parts = pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);

  let owner = DEFAULT_ORG;
  let repo = DEFAULT_REPO;
  let file = "install.sh";

  if (parts.length === 0) {
    // /
  } else if (parts.length === 1) {
    // /{repo} or /ps
    if (parts[0] === "ps") {
      file = "install.ps1";
    } else {
      repo = parts[0];
    }
  } else if (parts.length === 2) {
    // /{repo}/ps or /{owner}/{repo}
    if (parts[1] === "ps") {
      repo = parts[0];
    } else {
      owner = parts[0];
      repo = parts[1];
    }
  } else if (parts.length === 3 && parts[2] === "ps") {
    // /{owner}/{repo}/ps
    owner = parts[0];
    repo = parts[1];
    file = "install.ps1";
  } else {
    return null;
  }

  return `https://raw.githubusercontent.com/${owner}/${repo}/main/${file}`;
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const target = resolve(pathname);

    if (!target) {
      return new Response("Not found\n", { status: 404 });
    }

    const resp = await fetch(target, { cf: { cacheTtl: CACHE_TTL } });

    if (!resp.ok) {
      return new Response("Not found\n", { status: 404 });
    }

    return new Response(resp.body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL}`,
      },
    });
  },
};
