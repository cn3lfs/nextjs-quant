import { describe, expect, it } from "vitest";
import {
  formulaPrompt,
  type FormulaDraft,
} from "~/lib/formula/formula-from-text";
import { arities, futureFunctions } from "~/lib/formula/tdx-formula-check";
import { formulaFromText } from "~/server/screening/formula-from-text";

const draft = (source: string, unsupported: string[] = []): FormulaDraft => ({
  source,
  explanation: [{ line: source, meaning: "测试" }],
  unsupported,
});
/** Fake model: replies in order and records the prompts it was given. */
function model(...replies: FormulaDraft[]) {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      return { data: replies[prompts.length - 1]!, tokens: 10 };
    },
  };
}
const macdCross =
  "DIF:=EMA(C,12)-EMA(C,26);\nDEA:=EMA(DIF,9);\nCROSS(DIF,DEA) AND RPS250>90;";

describe("formulaFromText", () => {
  it("returns a draft that passes the screening gate on the first try", async () => {
    const m = model(draft(macdCross));
    const result = await formulaFromText(
      "MACD金叉且RPS250大于90",
      undefined,
      m.complete,
    );
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      tokens: 10,
      source: macdCross,
    });
    expect(m.prompts).toHaveLength(1);
  });

  it("feeds checker issues back once and accepts the repaired draft", async () => {
    const m = model(
      draft("CROSS(C,MA(C,5)) AND ZIG(3,10)>0;"),
      draft("CROSS(C,MA(C,5));"),
    );
    const result = await formulaFromText("站上5日线", undefined, m.complete);
    expect(result).toMatchObject({ ok: true, attempts: 2, tokens: 20 });
    expect(m.prompts[1]).toContain("未通过校验");
    expect(m.prompts[1]).toContain("ZIG");
    expect(m.prompts[1]).toContain("CROSS(C,MA(C,5)) AND ZIG(3,10)>0;");
  });

  it("reports rather than runs a draft that still fails after the repair round", async () => {
    const m = model(
      draft("A:C>1;B:C<2;"),
      draft("A:C>1;B:C<2;", ["主力净流入"]),
    );
    const result = await formulaFromText("两个输出", undefined, m.complete);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(2);
    expect(result.issues[0]?.reason).toContain("恰有一个输出");
    expect(result.unsupported).toEqual(["主力净流入"]);
  });

  it("rejects future functions and unknown names in every attempt", async () => {
    const m = model(draft("BACKSET(C>1,2);"), draft("FOO(C)>1;"));
    const result = await formulaFromText("未来函数", undefined, m.complete);
    expect(result.ok).toBe(false);
  });
});

it("treats an empty draft as the select-nothing formula, not an error", async () => {
  const m = model(draft("", ["市盈率低于20倍"]));
  const result = await formulaFromText("市盈率低于20倍", undefined, m.complete);
  expect(result).toMatchObject({
    ok: true,
    source: "0;",
    unsupported: ["市盈率低于20倍"],
  });
});

describe("formulaPrompt", () => {
  it("lists exactly the engine's functions and forbidden names", () => {
    const prompt = formulaPrompt("测试");
    for (const name of Object.keys(arities))
      expect(prompt).toContain(`${name}/`);
    for (const name of futureFunctions) expect(prompt).toContain(name);
    expect(prompt).toContain("RPS250");
    expect(prompt).not.toContain("未通过校验");
  });
});
