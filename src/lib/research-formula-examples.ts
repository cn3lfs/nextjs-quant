import type { Bar } from "./domain";
import { evaluateFormula } from "./tdx-formula";

type Example = {
  method: string;
  title: string;
  source: string;
  original: string;
  formula: string;
  revision: string | null;
  parameters?: Readonly<Record<string, number>>;
  exit?: string;
  bearish?: boolean;
  needsCapital?: boolean;
};
const tutorial = "tdx-doc/references/tutorials/基础教程.md";
const skill = "tdx-doc/SKILL.md";
const expert = "tdx-doc/references/examples/专家系统.md";
const maOrder =
  "AA:=MA(CLOSE,5);BB:=MA(CLOSE,10);CC:=MA(CLOSE,30);T1:=AA>BB AND BB>CC;";
const boll =
  "MID:=MA(CLOSE,N);UPPER:=MID+2*STD(CLOSE,N);LOWER:=MID-2*STD(CLOSE,N);";
const macd =
  "DIFF:=EMA(CLOSE,SHORT)-EMA(CLOSE,LONG);DEA:=EMA(DIFF,M);MACD:=2*(DIFF-DEA);";
const base =
  "V1:=MA(VOL,5);V2:=VOL/REF(V1,1)>2;PZ1:=MA(CLOSE,M);PZ2:=HHV(HIGH,M);PZ3:=LLV(LOW,M);PZ4:=(PZ2-PZ1)/PZ1;PZ5:=(PZ1-PZ3)/PZ1;PZ:=REF(PZ4,1)<0.15 AND REF(PZ5,1)<0.15;TP1:HHV(HIGH,M);TP:=HIGH=TP1;V2 AND PZ AND TP;";
const exact = (
  method: string,
  title: string,
  formula: string,
  options: Partial<Example> = {},
): Example => {
  const row: Example = {
    method,
    title,
    source: tutorial,
    original: formula,
    formula,
    revision: null,
    ...options,
  };
  if (row.parameters) {
    for (const [name, value] of Object.entries(row.parameters))
      row.formula = row.formula.replace(
        new RegExp(`\\b${name}\\b`, "g"),
        String(value),
      );
    row.revision = `${row.revision ?? ""}现有执行核仅支持N1形式外部参数；修订执行式显式将原参数替换为上述固定字面量，原式保留不可运行状态。`;
  }
  return row;
};
// Original expressions remain distinct from repaired/parameterized experiments.
export const formulaExamples = {
  "tdx-macd-zero": exact(
    "SW12-macd-zero",
    "MACD柱零轴进退",
    `${macd}ENTERLONG:CROSS(MACD,0);EXITLONG:CROSS(0,MACD);`,
    {
      source: expert,
      parameters: { SHORT: 12, LONG: 26, M: 9 },
      revision:
        "原例未给参数，工程固定12/26/9；ENTERLONG/EXITLONG分别选择输出，原始双输出保留。",
    },
  ),
  "tdx-boll-reentry": exact(
    "SW12-boll-reentry",
    "布林下轨入上轨出",
    `${boll}ENTERLONG:CROSS(CLOSE,LOWER);EXITLONG:CROSS(CLOSE,UPPER);`,
    {
      source: expert,
      parameters: { N: 20 },
      revision: "原例未给N，工程固定20；上穿上轨退出，不改成下穿。",
    },
  ),
  "tdx-volume-double": exact(
    "SW12-volume",
    "当日量严格超过昨日两倍",
    "VOL/REF(VOL,1)>2;",
  ),
  "tdx-volume-five-four": exact(
    "SW12-volume",
    "五日均量严格超过五日前四倍",
    "AA:=MA(VOL,5);BB:=REF(AA,5);AA/BB>4;",
  ),
  "tdx-volume-half": exact(
    "SW12-volume",
    "当日量严格小于昨日一半",
    "VOL/REF(VOL,1)<0.5;",
  ),
  "tdx-volume-five-half": exact(
    "SW12-volume",
    "五日均量严格小于五日前一半",
    "AA:=MA(VOL,5);BB:=REF(AA,5);AA/BB<0.5;",
  ),
  "tdx-volume-capital-high": exact(
    "SW12-volume",
    "换手严格超过10% · 时点股本修订",
    "VOL/CAPITAL>10/100;",
    {
      formula: "VOL/N1>10/100;",
      needsCapital: true,
      revision:
        "原CAPITAL不支持且当前股本不可回填；修订版只接受观察日已知同单位流通股本FLOATUNITS。",
    },
  ),
  "tdx-volume-capital-low": exact(
    "SW12-volume",
    "换手严格低于0.5% · 时点股本修订",
    "VOL/CAPITAL<0.5/100;",
    {
      formula: "VOL/N1<0.5/100;",
      needsCapital: true,
      revision:
        "原CAPITAL不支持且当前股本不可回填；修订版只接受观察日已知同单位流通股本FLOATUNITS。",
    },
  ),
  "tdx-price-seven": exact(
    "SW12-price",
    "涨幅严格超过7%",
    "CLOSE/REF(CLOSE,1)>1.07;;",
    {
      formula: "CLOSE/REF(CLOSE,1)>1.07;",
      revision:
        "原例双分号不能通过当前语法核；修订版只删除多余分号，原式不可运行状态保留。",
    },
  ),
  "tdx-price-ma-rise": exact(
    "SW12-price",
    "十日均价上涨 · REE修订",
    "AA:=MA(CLOSE,10);BB:=REE(AA,1);AA>BB;",
    {
      formula: "AA:=MA(CLOSE,10);BB:=REF(AA,1);AA>BB;",
      revision: "原例REE未支持，明确修订为REF；原式不可运行，不称等价执行。",
    },
  ),
  "tdx-price-bull": exact("SW12-price", "收阳", "CLOSE>OPEN;"),
  "tdx-price-bear": exact("SW12-price", "收阴退出", "CLOSE<OPEN;", {
    bearish: true,
  }),
  "tdx-price-volume-attack": exact(
    "SW12-price",
    "量超过两倍且涨幅超过7%",
    "AA:=VOL/REF(VOL,1)>2;BB:=CLOSE/REF(CLOSE,1)>1.07;AA AND BB;",
  ),
  "tdx-price-high": exact(
    "SW12-price",
    "当根最高价等于N日最高",
    "HIGH=HHV(HIGH,N);",
    {
      parameters: { N: 20 },
      revision: "原例未给N，工程固定20；包含当根且相等可命中，不改成严格突破。",
    },
  ),
  "tdx-price-range": exact(
    "SW12-price",
    "十日收盘振幅低于5%",
    "(HHV(CLOSE,10)-LLV(CLOSE,10))/CLOSE<0.05;",
  ),
  "tdx-open-high": exact("SW12-gap", "高开", "OPEN>REF(CLOSE,1);"),
  "tdx-open-low": exact("SW12-gap", "低开退出", "OPEN<REF(CLOSE,1);", {
    bearish: true,
  }),
  "tdx-gap-up": exact("SW12-gap", "开盘高于前高", "OPEN>REF(HIGH,1);"),
  "tdx-gap-down": exact("SW12-gap", "开盘低于前低退出", "OPEN<REF(LOW,1);", {
    bearish: true,
    revision:
      "文字写昨日最高，公式写LOW；按公式执行并保留文字冲突，不改写为HIGH。",
  }),
  "tdx-gap-unfilled": exact(
    "SW12-gap-unfilled",
    "两日缺口 · 固定同一前高",
    "AA:=REF(OPEN,1)>REF(HIGH,2);BB:=REF(LOW,1)>REF(HIGH,2);CC:=LOW>REF(HIGH,2);AA AND BB AND CC;",
  ),
  "tdx-gap-count-original": exact(
    "SW12-gap-unfilled",
    "两日缺口 · 原COUNT不同锚点对照",
    "COUNT(LOW>REF(HIGH,2),2)=2;",
    {
      revision:
        "原文称简化等价，但前一日比较的是三日前高，非两日前高；保留独立原式，不能与固定锚点版合并。",
    },
  ),
  "tdx-ma-order": exact("SW12-ma-order", "5/10/30多头排列", `${maOrder}T1;`),
  "tdx-ma-order-four": exact(
    "SW12-ma-order",
    "5/10/30排列连续四日",
    `${maOrder}COUNT(T1,4)=4;`,
  ),
  "tdx-base-breakout": exact("SW12-base-breakout", "150日横盘放量新高", base, {
    parameters: { M: 150 },
    revision:
      "原式两个输出：TP1只是高点线，信号仅取最后布尔输出；放量依公式比较昨日5日均量，不依文中昨日单量。",
  }),
  "tdx-skill-cross": exact(
    "SW12-skill-cross",
    "均线5/10金叉示例",
    "CROSS(MA(C,5),MA(C,10));",
    { source: skill, exit: "CROSS(MA(C,10),MA(C,5));" },
  ),
  "tdx-new-high": exact(
    "SW12-new-high",
    "收盘达到含当根20日最高价",
    "C>=HHV(H,20);",
    { source: skill },
  ),
  "tdx-three-volume": exact(
    "SW12-three-volume",
    "连续三日逐日增量",
    "EVERY(V>REF(V,1),3);",
    { source: skill },
  ),
} satisfies Record<string, Example>;
export type FormulaExampleId = keyof typeof formulaExamples;
export const formulaExampleIds = Object.keys(
  formulaExamples,
) as FormulaExampleId[];
export function isFormulaExample(id: string): id is FormulaExampleId {
  return Object.hasOwn(formulaExamples, id);
}
export type FormulaCapitalEvidence = {
  date: string;
  availableDate: string;
  source: string;
  floatShares: number;
  volumeUnit: "share" | "lot100";
};
export function formulaOriginalStatus(id: FormulaExampleId) {
  const row: Example = formulaExamples[id];
  try {
    evaluateFormula(row.original, [], row.parameters);
    return { runnable: true, reason: null };
  } catch (error) {
    return {
      runnable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
export function formulaExampleDefinition(id: FormulaExampleId) {
  const row: Example = formulaExamples[id],
    original = formulaOriginalStatus(id);
  return {
    label: row.title,
    family: "通达信示例",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    sources: [row.source],
    description: `${row.revision ?? "原逻辑执行。"}原式：${row.original}；原式${original.runnable ? "可由现有公式核执行" : `不可运行：${original.reason}`}。执行式：${row.formula}。参数${JSON.stringify(row.parameters ?? {})}。工程交易适配：${row.bearish ? "MA5/10金叉为入场基线，选定原式成立退出" : "条件首次成立入场，专家系统按其具名出场；其他条件用MA5/10死叉退出"}，同日退出优先，下一可成交开盘、最长持有期、T+1沿用共享执行器。不是自动交易或完整原作者体系；无公司行动证明须覆盖全部输入。${row.needsCapital ? "真实历史股本尚未接入；逐观察日date、availableDate、source、floatShares、volumeUnit缺一则待数据。" : ""}`,
  };
}
export function researchFormulaExampleSeries(
  id: FormulaExampleId,
  bars: readonly Bar[],
  capital: readonly FormulaCapitalEvidence[] = [],
) {
  const row: Example = formulaExamples[id];
  const original = formulaOriginalStatus(id);
  const valid = (b: Bar) =>
    Number.isFinite(b.volume) &&
    b.volume > 0 &&
    [b.open, b.high, b.low, b.close].every(
      (v) => Number.isFinite(v) && v > 0,
    ) &&
    b.high >= Math.max(b.open, b.close) &&
    b.low <= Math.min(b.open, b.close);
  // Invalid bars remain explicit unknowns for the formula core, rather than being removed.
  const input = bars.map((b) =>
    valid(b)
      ? b
      : {
          ...b,
          open: NaN,
          close: NaN,
          high: NaN,
          low: NaN,
          volume: NaN,
          amount: NaN,
        },
  );
  const outputs = row.needsCapital
    ? null
    : evaluateFormula(row.formula, input).outputs;
  const baseline = evaluateFormula(
    "ENTRY:CROSS(MA(C,5),MA(C,10));EXIT:CROSS(MA(C,10),MA(C,5));",
    input,
  ).outputs;
  const explicitExit = row.exit
    ? evaluateFormula(row.exit, input).outputs.at(-1)!.values
    : null;
  let previous: number | null = null;
  return bars.map((bar, i) => {
    let value: number | null = null,
      evidence: FormulaCapitalEvidence | null = null;
    let reason: string | null = null;
    if (row.needsCapital) {
      const rows = capital.filter((e) => e.date === bar.date);
      evidence = rows.length === 1 ? rows[0]! : null;
      if (
        !evidence ||
        !/^\d{4}-\d{2}-\d{2}$/.test(evidence.availableDate) ||
        evidence.availableDate > bar.date ||
        !evidence.source.trim() ||
        !Number.isFinite(evidence.floatShares) ||
        evidence.floatShares <= 0 ||
        !["share", "lot100"].includes(evidence.volumeUnit)
      )
        reason = "待数据：观察日已知流通股本及同单位成交量证据缺失/冲突";
      else
        value = evaluateFormula(row.formula, input.slice(0, i + 1), {
          N1:
            evidence.floatShares / (evidence.volumeUnit === "lot100" ? 100 : 1),
        }).outputs.at(-1)!.values[i]!;
    } else
      value = (outputs!.find((o) => o.name === "ENTERLONG") ?? outputs!.at(-1)!)
        .values[i]!;
    if (value === null && reason === null)
      reason = "公式窗口不足或价量输入未知";
    const expertExit = outputs?.find((o) => o.name === "EXITLONG");
    const exitValue = row.bearish
      ? value
      : expertExit
        ? expertExit.values[i]
        : explicitExit
          ? explicitExit[i]
          : baseline[1]!.values[i];
    const exit =
      valid(bar) &&
      exitValue !== null &&
      exitValue !== undefined &&
      exitValue !== 0;
    const entry =
      valid(bar) &&
      !reason &&
      !exit &&
      (row.bearish
        ? baseline[0]!.values[i] === 1
        : value !== 0 && value !== null && previous === 0);
    previous = value;
    const values: Record<string, number | null> = {
      close: Number.isFinite(bar.close) ? bar.close : null,
      formula: value,
    };
    return {
      date: bar.date,
      entry,
      exit,
      reason,
      values,
      formula: {
        id,
        original,
        expression: row.formula,
        parameters: row.parameters ?? {},
        evidence,
      },
    };
  });
}
