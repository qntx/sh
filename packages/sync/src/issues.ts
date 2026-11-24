// Issue tracking for sync failures: a pure planner that maps the per-app
// sync status plus the open `sync`-labelled issues to the actions the
// tracker should take. One issue per failing subject, exact title match;
// updated while it fails, closed when it syncs again.

import type { SyncStatus } from "./status.ts";

export type Subject = { title: string; ok: boolean; error?: string };

export type OpenIssue = { number: number; title: string; body: string };

export type IssueAction =
  | { kind: "create"; title: string; body: string }
  | { kind: "update"; number: number; body: string }
  | { kind: "close"; number: number; comment: string };

const TITLE_PREFIX = "sync: ";
const TITLE_SUFFIX = " failing";
const ERROR_LIMIT = 4000;

export function subjectsFrom(app: "sh" | "sk", status: SyncStatus): Subject[] {
  const prefix = app === "sk" ? "sk:" : "";
  const subjects: Subject[] = [];
  for (const key of status.ok) {
    subjects.push({ title: `${TITLE_PREFIX}${prefix}${key}${TITLE_SUFFIX}`, ok: true });
  }
  for (const key of Object.keys(status.failed)) {
    subjects.push({
      title: `${TITLE_PREFIX}${prefix}${key}${TITLE_SUFFIX}`,
      ok: false,
      error: status.failed[key] ?? "",
    });
  }
  return subjects;
}

function bodyFor(subject: Subject, runUrl: string): string {
  const name = subject.title.slice(TITLE_PREFIX.length, -TITLE_SUFFIX.length);
  const error = (subject.error ?? "").replaceAll("```", "'''");
  const truncated =
    error.length > ERROR_LIMIT
      ? `${error.slice(0, ERROR_LIMIT)}\n… (truncated, ${error.length - ERROR_LIMIT} more characters)`
      : error;
  return [
    `The \`Sync\` workflow fails for \`${name}\`. Its lock entry stays at the last good state; every other tool keeps syncing.`,
    "",
    `Latest failing run: ${runUrl}`,
    "",
    "```text",
    truncated,
    "```",
    "",
    `Updated by every failing run; closed automatically when \`${name}\` syncs again.`,
    "",
  ].join("\n");
}

export function planIssues(subjects: Subject[], open: OpenIssue[], runUrl: string): IssueAction[] {
  const actions: IssueAction[] = [];
  for (const subject of subjects) {
    // Several open issues may share the title; act on the oldest only.
    const issue = open
      .filter((i) => i.title === subject.title)
      .toSorted((a, b) => a.number - b.number)
      .at(0);
    if (subject.ok) {
      if (issue !== undefined) {
        actions.push({
          kind: "close",
          number: issue.number,
          comment: `Synced again in ${runUrl}.`,
        });
      }
      continue;
    }
    const body = bodyFor(subject, runUrl);
    if (issue === undefined) {
      actions.push({ kind: "create", title: subject.title, body });
    } else if (issue.body !== body) {
      actions.push({ kind: "update", number: issue.number, body });
    }
  }
  return actions;
}
