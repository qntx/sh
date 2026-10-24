import type { Release } from "@qntx/github";

import type { Deps } from "../src/sync.ts";

export const ENC: TextEncoder = new TextEncoder();
export const SKILL: Uint8Array = ENC.encode(
  "---\nname: kobe\ndescription: A skill.\n---\n# kobe\n",
);
export const SHA: string = "40".repeat(20);

export function rel(tag: string): Release {
  return { tag_name: tag, draft: false, prerelease: false, immutable: false, assets: [] };
}

export function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    repo: (name) => ({
      full_name: name,
      private: false,
      archived: false,
      description: "",
      default_branch: "main",
    }),
    releases: () => [rel("v1.0.0")],
    commit: () => ({ sha: SHA }),
    listDir: (_n, path) =>
      path === "skills"
        ? [{ name: "kobe", type: "dir", path: "skills/kobe" }]
        : [{ name: "SKILL.md", type: "file", path: `${path}/SKILL.md` }],
    fileAtRef: () => SKILL,
    ...overrides,
  };
}

// listDir fake: the kobe skill dir contains SKILL.md plus one extra file.
export const extraFileListDir: Deps["listDir"] = (_n, path) =>
  path === "skills"
    ? [{ name: "kobe", type: "dir", path: "skills/kobe" }]
    : [
        { name: "SKILL.md", type: "file", path: `${path}/SKILL.md` },
        { name: "extra.md", type: "file", path: `${path}/extra.md` },
      ];
