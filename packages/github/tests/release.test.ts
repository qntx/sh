import { describe, expect, test } from "vite-plus/test";

import type { Release } from "../src/client.ts";
import { latestStable } from "../src/release.ts";

function rel(tag: string, opts: { draft?: boolean; prerelease?: boolean } = {}): Release {
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    immutable: false,
    assets: [],
  };
}

describe("latestStable", () => {
  test("picks highest semver, not GitHub's 'Latest' flag", () => {
    const rs = [rel("ffi-v0.2.0"), rel("v0.9.3"), rel("v0.10.0"), rel("v0.9.9")];
    expect(latestStable(rs)?.tag_name).toBe("v0.10.0");
  });

  test("ignores drafts and prereleases", () => {
    const rs = [rel("v2.0.0", { draft: true }), rel("v3.0.0", { prerelease: true }), rel("v1.0.0")];
    expect(latestStable(rs)?.tag_name).toBe("v1.0.0");
  });

  test("numeric compare, not lexicographic", () => {
    const rs = [rel("v1.10.0"), rel("v1.9.0")];
    expect(latestStable(rs)?.tag_name).toBe("v1.10.0");
  });

  test("undefined when no stable tag", () => {
    expect(
      latestStable([rel("ffi-v0.2.0"), rel("v1.0.0-rc.1", { prerelease: true })]),
    ).toBeUndefined();
    expect(latestStable([])).toBeUndefined();
  });
});
