// Offline, deterministic rendering of the sk.qntx.org site.

export type SkillEntry = {
  name: string;
  description: string;
  digest: string;
};

const BASE = "https://sk.qntx.org";
const WELL_KNOWN = "/.well-known/agent-skills";

export function indexJson(skills: SkillEntry[]): string {
  const body = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: skills
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        name: s.name,
        type: "skill-md",
        description: s.description,
        url: `${WELL_KNOWN}/${s.name}/SKILL.md`,
        digest: `sha256:${s.digest}`,
      })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function llmsTxt(skills: SkillEntry[]): string {
  const lines = [
    "# sk.qntx.org",
    "",
    "> Agent skills discovery endpoint for QuantX tools.",
    "",
    `Install all skills with \`npx skills add ${BASE}\` or fetch one at \`${BASE}/<name>\`.`,
    "",
    "## Skills",
    "",
    ...skills
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((s) => `- [${s.name}](${BASE}/${s.name}): ${s.description}`),
    "",
  ];
  return lines.join("\n");
}

export function redirects(skills: SkillEntry[]): string {
  const lines = [
    "/ /llms.txt 200",
    ...skills
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((s) => `/${s.name} ${WELL_KNOWN}/${s.name}/SKILL.md 200`),
    "",
  ];
  return lines.join("\n");
}

// Cloudflare _headers: a request path can match several rules and the
// platform then joins duplicate header values with commas — so Content-Type
// must be set by exactly one matching rule per path. The /* wildcard sets
// only non-Content-Type headers; each Content-Type rule is on a distinct
// path prefix. (https://developers.cloudflare.com/workers/static-assets/headers/)
export function headers(skills: SkillEntry[]): string {
  const lines = [
    "/*",
    "  Access-Control-Allow-Origin: *",
    "  X-Content-Type-Options: nosniff",
    "",
    "/llms.txt",
    "  Content-Type: text/plain; charset=utf-8",
    "",
    "/",
    "  Content-Type: text/plain; charset=utf-8",
    "",
    `${WELL_KNOWN}/index.json`,
    "  Content-Type: application/json",
    "",
    `${WELL_KNOWN}/*/SKILL.md`,
    "  Content-Type: text/markdown; charset=utf-8",
  ];
  for (const s of skills.toSorted((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      "",
      `/${s.name}`,
      "  Content-Type: text/markdown; charset=utf-8",
      `  Link: <${WELL_KNOWN}/${s.name}/SKILL.md>; rel="canonical"`,
    );
  }
  lines.push("", "");
  return lines.join("\n");
}
