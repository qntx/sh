import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

import { fmt } from "@qntx/oxfmt";
import base, { merge } from "@qntx/oxlint";

const config: UserConfig = defineConfig({
  staged: { "*": "vp check --fix" },
  fmt: {
    ...fmt,
    ignorePatterns: [
      ...fmt.ignorePatterns,
      // TOML is owned by taplo (.taplo.toml, align_entries).
      "**/*.toml",
      "target/**",
      "bun.lock",
      "**/dist/**",
      // Skill bytes are hash-locked to upstream — never reformat them.
      "apps/*/content/**",
    ],
  },
  lint: merge(base, {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // oxfmt canonicalizes hex digits to lowercase; this rule demands uppercase, so fmt always wins.
      "unicorn/number-literal-case": "off",
    },
    overrides: [
      {
        // Script entrypoints print their results.
        files: ["apps/*/src/build.ts", "apps/*/src/sync.ts", "apps/*/scripts/**", "scripts/**"],
        rules: { "eslint/no-console": "off" },
      },
      {
        // isolatedDeclarations requires explicit annotations; the
        // inferrable-types lint disagrees on simple regex/Set initializers.
        files: ["apps/*/src/**", "packages/*/src/**"],
        rules: { "typescript/no-inferrable-types": "off" },
      },
      {
        files: ["apps/*/tests/**", "packages/*/tests/**"],
        rules: {
          // Custom assertion helpers (fails() wraps expect).
          "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "fails"] }],
        },
      },
    ],
  }),
  run: { cache: process.env["CI"] === undefined || process.env["CI"] === "" },
});

export default config;
