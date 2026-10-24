import { execFileSync } from "node:child_process";

import { defineConfig } from "bumpp";

// The Cargo workspace version is the only versioned artifact today (apps
// deploy continuously). bumpp rewrites every `0.1.x` occurrence in
// Cargo.toml — [workspace.package].version plus the `upg = "=x.y.z"` dep.
const config: ReturnType<typeof defineConfig> = defineConfig({
  files: ["Cargo.toml"],
  execute: () => {
    execFileSync("cargo", ["update", "--workspace"], { stdio: "inherit" });
  },
  // execute rewrites Cargo.lock; commit it too.
  all: true,
  commit: true,
  // main is protected: release through a `release/v<version>` pull request
  // opened via `gh`. No tag is created; after the release PR merges, tag the
  // merge commit by hand (GITHUB_TOKEN tags do not trigger publish workflows).
  pr: true,
  push: true,
});

export default config;
