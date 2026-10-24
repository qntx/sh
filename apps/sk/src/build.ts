// Offline, deterministic build (`bun run build`): verify lock ↔ content,
// render dist/. Any mismatch fails before dist/ is touched.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "@qntx/sync";

import { fail, loadLock } from "./lock.ts";
import { headers, indexJson, llmsTxt, redirects } from "./render.ts";
import type { SkillEntry } from "./render.ts";
import { validateSkill } from "./skill.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const CONTENT = join(ROOT, "content");

function main(): void {
  const lock = loadLock(join(ROOT, "skills.lock.json"));

  // Locked skill set and content directory set must match exactly.
  const locked = new Set<string>();
  const lockedHashes = new Map<string, string>();
  for (const src of Object.values(lock)) {
    for (const [name, hash] of Object.entries(src.skills)) {
      if (locked.has(name)) {
        fail(`${name}: locked by more than one source`);
      }
      locked.add(name);
      lockedHashes.set(name, hash);
    }
  }
  const onDisk = readdirSync(CONTENT).toSorted();
  const expected = [...locked].toSorted();
  if (JSON.stringify(onDisk) !== JSON.stringify(expected)) {
    fail(`lock/content mismatch: lock=[${expected.join(",")}] content=[${onDisk.join(",")}]`);
  }

  const entries: SkillEntry[] = [];
  const contents = new Map<string, Uint8Array>();
  for (const name of expected) {
    const file = join(CONTENT, name, "SKILL.md");
    const bytes = new Uint8Array(readFileSync(file));
    const digest = sha256Hex(bytes);
    if (digest !== lockedHashes.get(name)) {
      fail(`${name}: content sha256 does not match the lock`);
    }
    const skill = validateSkill(name, bytes);
    entries.push({ name, description: skill.fm.description, digest });
    contents.set(name, bytes);
  }

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  const wk = join(DIST, ".well-known", "agent-skills");
  mkdirSync(wk, { recursive: true });
  writeFileSync(join(wk, "index.json"), indexJson(entries));
  for (const name of expected) {
    const dir = join(wk, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), contents.get(name) ?? fail(`${name}: missing bytes`));
  }
  writeFileSync(join(DIST, "llms.txt"), llmsTxt(entries));
  writeFileSync(join(DIST, "_redirects"), redirects(entries));
  writeFileSync(join(DIST, "_headers"), headers(entries));

  const count = readdirSync(DIST, { recursive: true }).length;
  process.stdout.write(`dist: ${expected.length} skills, ${count} entries\n`);
}

main();
