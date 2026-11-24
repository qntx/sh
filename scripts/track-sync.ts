// Sync-failure issue tracker (run by the issues job of the Sync workflow).
// Reads the per-app status JSON the sync steps wrote, lists the open
// `sync`-labelled issues, plans create/update/close actions via
// @qntx/sync's planIssues, and executes them with `gh`. Set DRY_RUN=1 to
// print the plan without touching anything.

import { spawnSync } from "node:child_process";

import { isRecord, parseStatus, planIssues, subjectsFrom } from "@qntx/sync";
import type { IssueAction, OpenIssue, Subject } from "@qntx/sync";

function env(name: string): string {
  return process.env[name] ?? "";
}

function gh(args: string[], input?: string): string {
  const r = spawnSync("gh", args, {
    input: input ?? "",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(" ")} exited ${String(r.status)}`);
  }
  return r.stdout;
}

function subjectsFor(app: "sh" | "sk", raw: string): Subject[] {
  if (raw === "") {
    return [];
  }
  return subjectsFrom(app, parseStatus(JSON.parse(raw)));
}

function openIssue(raw: unknown): OpenIssue {
  if (!isRecord(raw)) {
    throw new Error("unexpected gh issue list output");
  }
  const { number, title, body } = raw;
  if (typeof number !== "number" || typeof title !== "string" || typeof body !== "string") {
    throw new TypeError("unexpected gh issue list output");
  }
  return { number, title, body };
}

function describe(a: IssueAction): string {
  if (a.kind === "create") {
    return `create "${a.title}"`;
  }
  return a.kind === "update" ? `update #${a.number}` : `close #${a.number}`;
}

function main(): number {
  const repo = env("GITHUB_REPOSITORY");
  const runUrl = env("RUN_URL");
  const dryRun = env("DRY_RUN") === "1";
  if (repo === "" || runUrl === "") {
    process.stderr.write("error: GITHUB_REPOSITORY and RUN_URL are required\n");
    return 1;
  }

  const subjects = [...subjectsFor("sh", env("SH_STATUS")), ...subjectsFor("sk", env("SK_STATUS"))];
  if (subjects.length === 0) {
    process.stdout.write("No sync status; nothing to track.\n");
    return 0;
  }

  if (!dryRun) {
    gh([
      "label",
      "create",
      "sync",
      "--description",
      "Sync workflow tracking",
      "--color",
      "B60205",
      "--force",
      "--repo",
      repo,
    ]);
  }

  const raw = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    "sync",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,title,body",
  ]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new TypeError("unexpected gh issue list output");
  }
  const open: OpenIssue[] = parsed.map(openIssue);

  const actions = planIssues(subjects, open, runUrl);
  if (actions.length === 0) {
    process.stdout.write("No issue actions needed.\n");
    return 0;
  }

  for (const a of actions) {
    process.stdout.write(`${dryRun ? "[dry-run] " : ""}${describe(a)}\n`);
    if (dryRun) {
      continue;
    }
    switch (a.kind) {
      case "create":
        gh(
          [
            "issue",
            "create",
            "--repo",
            repo,
            "--title",
            a.title,
            "--label",
            "sync",
            "--body-file",
            "-",
          ],
          a.body,
        );
        break;
      case "update":
        gh(["issue", "edit", String(a.number), "--repo", repo, "--body-file", "-"], a.body);
        break;
      case "close":
        gh(["issue", "close", String(a.number), "--repo", repo, "--comment", a.comment]);
        break;
    }
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
