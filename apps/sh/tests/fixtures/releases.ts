import type { Release } from "@qntx/sync";

export function rel(
  tag: string,
  assets: string[],
  opts: { draft?: boolean; prerelease?: boolean; digest?: boolean } = {},
): Release {
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    immutable: false,
    assets: assets.map((name) => ({
      name,
      browser_download_url: `https://example.com/${name}`,
      digest: opts.digest === false ? undefined : `sha256:${"a".repeat(64)}`,
    })),
  };
}

export function assetSet(bin: string, ver: string, targets: string[]): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const ext = t.endsWith("msvc") ? "zip" : "tar.gz";
    out.push(`${bin}-${ver}-${t}.${ext}`, `${bin}-${ver}-${t}.${ext}.sha256`);
  }
  return out;
}

export const H: string = "a".repeat(64);

export async function fails(p: Promise<unknown>, part: string): Promise<void> {
  try {
    await p;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes(part)) {
      throw new Error(`expected error containing "${part}", got "${msg}"`, { cause: error });
    }
    return;
  }
  throw new Error(`expected failure containing "${part}"`);
}
export const sums = (_r: Release, _n: string): string => `${H}  ${_n.replace(/\.sha256$/, "")}\n`;
