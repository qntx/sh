import { describe, expect, test } from "vite-plus/test";

import { validateSkill } from "../src/skill.ts";

const ENC = new TextEncoder();

function fm(fmYaml: string, body = "body\n"): Uint8Array {
  return ENC.encode(`---\n${fmYaml}---\n${body}`);
}

const GOOD = fm("name: kobe\ndescription: A skill.\n");

describe("validateSkill", () => {
  test("accepts a valid file", () => {
    const s = validateSkill("kobe", GOOD);
    expect(s.fm.name).toBe("kobe");
    expect(s.fm.description).toBe("A skill.");
    expect(s.body).toBe("body\n");
  });

  test.each([
    [
      "BOM",
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...ENC.encode("---\nname: kobe\ndescription: x\n---\nb\n"),
      ]),
    ],
    ["empty", new Uint8Array(0)],
    ["no frontmatter", ENC.encode("# hi\n")],
    ["unclosed frontmatter", ENC.encode("---\nname: kobe\n")],
    ["non-mapping frontmatter", fm("- a\n- b\n")],
    ["unknown key", fm("name: kobe\ndescription: x\nbogus: 1\n")],
    ["name mismatch", fm("name: other\ndescription: x\n")],
    ["name too long", fm(`name: kobe${"x".repeat(60)}\ndescription: y\n`)],
    ["name invalid chars", fm("name: Kobe\ndescription: x\n")],
    ["name empty", fm("name: ''\ndescription: x\n")],
    ["missing description", fm("name: kobe\n")],
    ["description empty", fm("name: kobe\ndescription: '  '\n")],
    ["description too long", fm(`name: kobe\ndescription: "${"x".repeat(1025)}"\n`)],
    [
      "compatibility too long",
      fm(`name: kobe\ndescription: x\ncompatibility: "${"x".repeat(501)}"\n`),
    ],
    ["metadata non-string", fm("name: kobe\ndescription: x\nmetadata:\n  a: 1\n")],
    ["allowed-tools non-string", fm("name: kobe\ndescription: x\nallowed-tools: 5\n")],
    ["license non-string", fm("name: kobe\ndescription: x\nlicense: [a]\n")],
    ["empty body", fm("name: kobe\ndescription: x\n", "")],
    ["bad yaml", fm("name: kobe\ndescription: x\n\tbad\n")],
  ])("rejects %s", (_label, bytes) => {
    expect(() => validateSkill("kobe", bytes)).toThrow(/.+/);
  });

  test("rejects oversized file", () => {
    const big = new Uint8Array(256 * 1024 + 1);
    expect(() => validateSkill("kobe", big)).toThrow(/256|exceeds/);
  });

  test("optional fields parse", () => {
    const s = validateSkill(
      "kobe",
      fm(
        "name: kobe\ndescription: d\nlicense: MIT\ncompatibility: any\nallowed-tools: bash git\nmetadata:\n  a: b\n",
      ),
    );
    expect(s.fm.license).toBe("MIT");
    expect(s.fm.allowedTools).toBe("bash git");
    expect(s.fm.metadata?.["a"]).toBe("b");
  });
});
