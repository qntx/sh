import { expect, test } from "vite-plus/test";

import { headers, indexJson, llmsTxt, redirects } from "../src/render.ts";

const skills = [
  { name: "kobe", description: "Wallet.", digest: "a".repeat(64) },
  { name: "nosfry", description: "Relay.", digest: "b".repeat(64) },
];

test("indexJson", () => {
  expect(indexJson(skills)).toBe(
    `{
  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  "skills": [
    {
      "name": "kobe",
      "type": "skill-md",
      "description": "Wallet.",
      "url": "/.well-known/agent-skills/kobe/SKILL.md",
      "digest": "sha256:${"a".repeat(64)}"
    },
    {
      "name": "nosfry",
      "type": "skill-md",
      "description": "Relay.",
      "url": "/.well-known/agent-skills/nosfry/SKILL.md",
      "digest": "sha256:${"b".repeat(64)}"
    }
  ]
}
`,
  );
});

test("llms.txt", () => {
  const t = llmsTxt(skills);
  expect(t).toContain("# sk.qntx.org");
  expect(t).toContain("npx skills add https://sk.qntx.org");
  expect(t).toContain("## Skills");
  expect(t).toContain("- [kobe](https://sk.qntx.org/kobe): Wallet.");
});

test("_redirects", () => {
  expect(redirects(skills)).toBe(
    "/ /llms.txt 200\n/kobe /.well-known/agent-skills/kobe/SKILL.md 200\n/nosfry /.well-known/agent-skills/nosfry/SKILL.md 200\n",
  );
});

test("_headers: no request path matches two Content-Type rules", () => {
  const h = headers(skills);
  expect(h).toContain("/*\n  Access-Control-Allow-Origin: *");
  // /* rule must not set Content-Type (it would merge-join on every path).
  const [wildcard] = h.split("\n\n");
  expect(wildcard).not.toContain("\n  Content-Type:");
  expect(h).toContain("/.well-known/agent-skills/index.json\n  Content-Type: application/json");
  expect(h).toContain("/kobe\n  Content-Type: text/markdown; charset=utf-8");
  expect(h).toContain('Link: </.well-known/agent-skills/kobe/SKILL.md>; rel="canonical"');
});
