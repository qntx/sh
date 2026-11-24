import { describe, expect, test } from "vite-plus/test";

import { deploySubject, planIssues, subjectsFrom } from "../src/issues.ts";
import type { IssueAction } from "../src/issues.ts";

const RUN = "https://github.com/qntx/sh/actions/runs/1";

const kinds = (actions: IssueAction[]): string[] => actions.map((a) => a.kind);

// Narrow the single planned action to a create; anything else fails here.
const created = (actions: IssueAction[]): { title: string; body: string } => {
  const [a] = actions;
  if (a === undefined || a.kind !== "create") {
    throw new Error(`expected a create action, got ${JSON.stringify(a)}`);
  }
  return a;
};

describe("subjectsFrom", () => {
  test("sh titles are 'sync: <tool> failing'", () => {
    const s = subjectsFrom("sh", { ok: ["kobe"], failed: { nosfry: "boom" } });
    expect(s).toStrictEqual([
      { title: "sync: kobe failing", ok: true },
      { title: "sync: nosfry failing", ok: false, error: "boom" },
    ]);
  });

  test("sk titles carry the sk: prefix", () => {
    const s = subjectsFrom("sk", { ok: [], failed: { "qntx/kobe": "boom" } });
    expect(s).toStrictEqual([{ title: "sync: sk:qntx/kobe failing", ok: false, error: "boom" }]);
  });
});

describe("deploySubject", () => {
  test("success produces an ok deploy subject", () => {
    expect(deploySubject("success", "")).toStrictEqual([
      { title: "sync: sk deploy failing", ok: true, kind: "deploy" },
    ]);
  });

  test("failure carries the error", () => {
    expect(deploySubject("failure", "no token")).toStrictEqual([
      { title: "sync: sk deploy failing", ok: false, error: "no token", kind: "deploy" },
    ]);
  });

  test("failure with an empty error falls back to a generic message", () => {
    expect(deploySubject("failure", "")).toStrictEqual([
      {
        title: "sync: sk deploy failing",
        ok: false,
        error: "The sk deploy failed; see the run log.",
        kind: "deploy",
      },
    ]);
  });

  test("skipped, cancelled and empty results produce no subject", () => {
    for (const result of ["", "skipped", "cancelled"]) {
      expect(deploySubject(result, "ignored")).toStrictEqual([]);
    }
  });
});

describe("planIssues", () => {
  const failing = [{ title: "sync: nosfry failing", ok: false, error: "err 1" }];
  const ok = [{ title: "sync: nosfry failing", ok: true }];

  test("failed subject with no open issue creates one", () => {
    const [a] = planIssues(failing, [], RUN);
    expect(a?.kind).toBe("create");
    expect(a).toMatchObject({ title: "sync: nosfry failing" });
  });

  test("issue body contains the subject, run URL and fenced error", () => {
    const a = created(planIssues(failing, [], RUN));
    expect(a.body).toContain("`nosfry`");
    expect(a.body).toContain(`Latest failing run: ${RUN}`);
    expect(a.body).toContain("```text\nerr 1\n```");
    expect(a.body).toContain("closed automatically when `nosfry` syncs again");
  });

  test("backticks in the error cannot break the fence", () => {
    const sub = [{ title: "sync: x failing", ok: false, error: "a```b" }];
    const a = created(planIssues(sub, [], RUN));
    expect(a.body).toContain("a'''b");
    expect(a.body).not.toContain("a```b");
  });

  test("errors longer than 4000 chars are truncated with a marker", () => {
    const sub = [{ title: "sync: x failing", ok: false, error: "x".repeat(5000) }];
    const a = created(planIssues(sub, [], RUN));
    expect(a.body).toContain("truncated");
    expect(a.body).toContain("x".repeat(4000));
    expect(a.body).not.toContain("x".repeat(4001));
  });

  test("failed subject with an open issue updates only when the body differs", () => {
    const c = created(planIssues(failing, [], RUN));
    // Same body → no action; different body → update.
    const same = planIssues(
      failing,
      [{ number: 7, title: "sync: nosfry failing", body: c.body }],
      RUN,
    );
    expect(same).toStrictEqual([]);
    const changed = planIssues(
      failing,
      [{ number: 7, title: "sync: nosfry failing", body: "stale" }],
      RUN,
    );
    expect(changed).toStrictEqual([{ kind: "update", number: 7, body: c.body }]);
  });

  test("ok subject with an open issue closes it", () => {
    const actions = planIssues(ok, [{ number: 3, title: "sync: nosfry failing", body: "b" }], RUN);
    expect(actions).toStrictEqual([
      { kind: "close", number: 3, comment: `Synced again in ${RUN}.` },
    ]);
  });

  test("open issues that are not current subjects are untouched", () => {
    const actions = planIssues(
      ok,
      [
        { number: 3, title: "sync: nosfry failing", body: "b" },
        { number: 4, title: "sync: other failing", body: "b" },
        { number: 5, title: "unrelated", body: "b" },
      ],
      RUN,
    );
    expect(kinds(actions)).toStrictEqual(["close"]);
  });

  test("a subject absent from the status produces nothing", () => {
    expect(
      planIssues([], [{ number: 1, title: "sync: kobe failing", body: "b" }], RUN),
    ).toStrictEqual([]);
  });

  test("duplicate open issues act on the lowest number only", () => {
    const actions = planIssues(
      ok,
      [
        { number: 9, title: "sync: nosfry failing", body: "b" },
        { number: 2, title: "sync: nosfry failing", body: "b" },
      ],
      RUN,
    );
    expect(actions).toStrictEqual([
      { kind: "close", number: 2, comment: `Synced again in ${RUN}.` },
    ]);
  });

  test("a failing deploy subject creates the deploy tracking issue", () => {
    const a = created(planIssues(deploySubject("failure", "no token"), [], RUN));
    expect(a.title).toBe("sync: sk deploy failing");
    expect(a.body).toContain("no token");
    expect(a.body).toContain(`Latest failing run: ${RUN}`);
    expect(a.body).toContain("-f deploy-sk=true");
  });

  test("an unchanged deploy body plans nothing", () => {
    const subjects = deploySubject("failure", "no token");
    const c = created(planIssues(subjects, [], RUN));
    expect(
      planIssues(subjects, [{ number: 5, title: "sync: sk deploy failing", body: c.body }], RUN),
    ).toStrictEqual([]);
  });

  test("a succeeding deploy subject closes the open issue", () => {
    const actions = planIssues(
      deploySubject("success", ""),
      [{ number: 5, title: "sync: sk deploy failing", body: "b" }],
      RUN,
    );
    expect(actions).toStrictEqual([{ kind: "close", number: 5, comment: `Deployed in ${RUN}.` }]);
  });
});
