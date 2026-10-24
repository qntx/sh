import { fmt } from "@qntx/oxfmt";

export default {
  ...fmt,
  ignorePatterns: [
    ...fmt.ignorePatterns,
    "dist/**",
    "tools/**",
    "templates/**",
    "test/fixtures/**",
    "bun.lock",
    "wrangler.jsonc",
  ],
};
