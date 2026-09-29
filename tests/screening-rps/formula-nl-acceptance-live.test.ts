import { expect, it } from "vitest";
import { formulaFromText } from "~/server/screening/formula-from-text";

/**
 * F1 acceptance against the configured real model (tokens are spent). Run with
 *   QUANT_FORMULA_NL_ACCEPTANCE=1 npx vitest run tests/screening-rps/formula-nl-acceptance-live.test.ts
 * using the data directory whose settings choose the provider. `expect` lists
 * tokens the formula must contain as a coarse semantic check; `unsupported`
 * cases must report the condition instead of inventing a field.
 */
const cases: { text: string; expect?: RegExp[]; unsupported?: true }[] = [
  { text: "收盘价站上20日均线", expect: [/MA\(\s*(C|CLOSE)\s*,\s*20\s*\)/] },
  { text: "5日均线上穿20日均线", expect: [/CROSS/, /5/, /20/] },
  { text: "MACD金叉", expect: [/EMA/, /CROSS/] },
  { text: "MACD零轴上方金叉", expect: [/EMA/, /CROSS/, />\s*0/] },
  { text: "KDJ的J值小于0", expect: [/LLV/, /HHV/] },
  { text: "RSI6低于20", expect: [/SMA|EMA/] },
  { text: "布林带下轨附近", expect: [/STD/] },
  { text: "RPS250大于90", expect: [/RPS250\s*>\s*90/] },
  { text: "RPS50和RPS120都大于85", expect: [/RPS50/, /RPS120/] },
  { text: "放量上涨", expect: [/VOL|\bV\b/] },
  {
    text: "成交量是5日均量的2倍以上",
    expect: [/MA\(\s*(VOL|V)\s*,\s*5\s*\)/, /2/],
  },
  { text: "创60日新高", expect: [/HHV/, /60/] },
  { text: "创20日新低", expect: [/LLV/, /20/] },
  { text: "连续3天上涨", expect: [/EVERY|COUNT/] },
  { text: "今天涨停", expect: [/REF\(\s*(C|CLOSE)\s*,\s*1\s*\)/] },
  { text: "涨幅大于5%", expect: [/REF/] },
  { text: "近10日振幅小于3%", expect: [/HHV|LLV|H|L/] },
  { text: "价格在10元到50元之间", expect: [/10/, /50/] },
  { text: "均线多头排列（5>10>20>60）", expect: [/MA/, /60/] },
  { text: "回踩10日线不破", expect: [/MA/, /10/] },
  { text: "跳空高开", expect: [/REF\(\s*(H|HIGH)\s*,\s*1\s*\)/] },
  { text: "长下影线", expect: [/L|LOW/] },
  { text: "年线上方且距离年线不超过10%", expect: [/250/] },
  { text: "底部放量突破平台", expect: [/HHV|VOL/] },
  { text: "RPS250大于90且MACD金叉且放量", expect: [/RPS250/, /CROSS/] },
  { text: "连续5日缩量", expect: [/VOL|\bV\b/] },
  { text: "缩量回调到20日均线", expect: [/MA/, /20/] },
  { text: "主力资金净流入超过5000万", unsupported: true },
  { text: "市盈率低于20倍", unsupported: true },
  { text: "属于人工智能概念板块", unsupported: true },
];

it.skipIf(process.env.QUANT_FORMULA_NL_ACCEPTANCE !== "1")(
  "one-sentence screening: ≥90% pass the gate, ≥80% match the coarse semantics",
  { timeout: 30 * 60 * 1000 },
  async () => {
    let gate = 0,
      semantic = 0,
      tokens = 0;
    const report: string[] = [];
    for (const c of cases) {
      const r = await formulaFromText(c.text);
      tokens += r.tokens;
      const source = r.source.toUpperCase();
      const passed = r.ok;
      const meaning = c.unsupported
        ? r.unsupported.length > 0
        : (c.expect ?? []).every((p) => p.test(source));
      gate += Number(passed || !!c.unsupported);
      semantic += Number(meaning);
      report.push(
        `${passed ? "✓" : "✗"}${meaning ? "✓" : "✗"} ${c.text} (${r.attempts}次) ⇒ ${r.source.replace(/\s+/g, " ")}${r.unsupported.length ? ` ｜未表达：${r.unsupported.join("；")}` : ""}`,
      );
    }
    console.log(
      [
        ...report,
        `门禁 ${gate}/${cases.length}，语义 ${semantic}/${cases.length}，tokens ${tokens}`,
      ].join("\n"),
    );
    expect(gate / cases.length).toBeGreaterThanOrEqual(0.9);
    expect(semantic / cases.length).toBeGreaterThanOrEqual(0.8);
  },
);
