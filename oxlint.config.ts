import { merge, config } from "@qntx/oxlint";

export default merge(config, {
  ignorePatterns: [
    ...(config.ignorePatterns ?? []),
    "dist/**",
    "tools/**",
    "templates/**",
    "test/fixtures/**",
    "wrangler.jsonc",
  ],
});
