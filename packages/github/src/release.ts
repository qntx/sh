// Pure release selection: newest stable vX.Y.Z tag. No I/O — unit-testable.

import type { Release } from "./client.ts";

export const STABLE_TAG_RE: RegExp = /^v(\d+)\.(\d+)\.(\d+)$/;

type SemVer = {
  major: number;
  minor: number;
  patch: number;
};

function compare(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/// Newest stable release: non-draft, non-prerelease, tag `vX.Y.Z`, max by
/// numeric semver (not by date or GitHub's "Latest" flag). Undefined when
/// none qualify — callers decide whether that is an error.
export function latestStable(releases: Release[]): Release | undefined {
  let best: Release | undefined;
  let bestV: SemVer | undefined;
  for (const r of releases) {
    if (r.draft || r.prerelease) {
      continue;
    }
    const m = STABLE_TAG_RE.exec(r.tag_name);
    if (m === null) {
      continue;
    }
    const v: SemVer = {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
    };
    if (bestV === undefined || compare(v, bestV) > 0) {
      best = r;
      bestV = v;
    }
  }
  return best;
}
