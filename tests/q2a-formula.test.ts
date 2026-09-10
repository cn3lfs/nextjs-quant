import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  evaluateFormula,
  parseFormula,
  FormulaError,
  futureFunctions,
} from "../src/lib/tdx-formula";
import {
  boll,
  ema,
  ma,
  emaSeries,
  smaSeries,
  stdSeries,
} from "../src/lib/indicators";
import type { Bar } from "../src/lib/domain";

const bars = (closes: number[]): Bar[] =>
  closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 * (i + 1),
    amount: 1000 * (i + 1),
  }));
const values = (
  source: string,
  data = bars([1, 2, 3, 4, 5]),
  parameters = {},
) => evaluateFormula(source, data, parameters).outputs[0]!.values;

describe("grammar, parameters and precedence", () => {
  it("Chinese names, comments, case-insensitivity, intermediate and named/unnamed outputs", () => {
    const out = evaluateFormula(
      "{注释\n跨行} 中间:=ma(c,N1);\n结果:中间+1; 中间>2;",
      bars([1, 2, 3]),
      { N1: 2 },
    );
    expect(out.outputs).toEqual([
      { name: "结果", line: 3, values: [null, 2.5, 3.5] },
      { name: "$2", line: 3, values: [null, 0, 1] },
    ]);
    expect(values("N1+N2;", bars([1]), { n1: 2, N2: 4 })).toEqual([6]);
  });
  it.each([
    ["1+2*3=7 AND 0 OR 1", 1],
    ["1 OR 0 AND 0", 1],
    ["8/2/2", 2],
    ["8-2-1", 5],
    ["-(1+2)*2", -6],
    ["NOT(0) AND 2<>3", 1],
    ["NOT 1+1", 1],
    ["1!=2 && 2>=2 || 0", 1],
    ["2<3 AND 3<=3 AND 4>3", 1],
    ["AND(1,OR(0,1))", 1],
    [".5+1e-1", 0.6],
  ])("operator expression %s", (source, result) =>
    expect(values(source, bars([1]))).toEqual([result]),
  );
  it.each([
    ["A:=1;\nX:MA(C,);", 2, "表达式"],
    ["A:=1;\nX:(C+1;", 2, "缺少 )"],
    ["A:=1\nX:C;", 2, "缺少 ;"],
    ["A:=1;\n{unclosed", 2, "注释"],
    ["X:C@2;", 1, "不支持的字符"],
    ["", 1, "为空"],
  ])("syntax reports line and reason", (source, line, reason) => {
    expect(() => parseFormula(source)).toThrow(`第${line}行`);
    expect(() => parseFormula(source)).toThrow(reason);
  });
  it.each([
    "X:MA(C,N1);",
    "X:MA(C,0);",
    "X:STD(C,1);",
    "X:SMA(C,3,4);",
    "X:LAST(C,1,3);",
    "X:MA(C,C);",
    "A:=REF(1,2);X:MA(C,A);",
    "C:=1;",
    "A:=1;A:=2;",
    "X:ABC;",
    "N1:=2;",
  ])("rejects undefined or invalid parameters: %s", (source) => {
    expect(() => evaluateFormula(source, [])).toThrow(FormulaError);
  });
  it("rejects unsafe parameter objects and never executes arbitrary code", () => {
    expect(() => values("N1", bars([1]), { N1: Infinity })).toThrow("有限数值");
    expect(() => values("N1", bars([1]), { N1: 1, n1: 2 })).toThrow("唯一");
    expect(() => values("constructor(C)")).toThrow("函数不支持");
    expect(() => values("__proto__(C)")).toThrow("函数不支持");
    expect(() => values("process.exit(1)")).toThrow();
  });
});

describe("whole-series semantics and common M1 primitives", () => {
  it("REF reads prior positions, never fills insufficient history", () => {
    expect(values("REF(C,2)")).toEqual([null, null, 1, 2, 3]);
    expect(values("REF(C,0)")).toEqual([1, 2, 3, 4, 5]);
  });
  it("MA/EMA/STD exactly match chart outputs", () => {
    const data = bars([10, 12, 9, 15, 11, 17]);
    expect(values("MA(C,3)", data)).toEqual(ma(data, 3));
    expect(values("EMA(C,3)", data)).toEqual(ema(data, 3));
    const out = evaluateFormula(
      "中轨:MA(C,3);上轨:MA(C,3)+2*STD(C,3);下轨:MA(C,3)-2*STD(C,3);",
      data,
    ).outputs;
    expect(out[0]!.values).toEqual(boll(data, 3).map((x) => x.mid));
    expect(out[1]!.values).toEqual(boll(data, 3).map((x) => x.upper));
    expect(out[2]!.values).toEqual(boll(data, 3).map((x) => x.lower));
  });
  it("handles negative and zero sequence values and sample STD (N-1)", () => {
    expect(values("MA(C-3,3)")).toEqual([null, null, -1, 0, 1]);
    expect(values("EMA(C-3,3)")).toEqual([-2, -1.5, -0.75, 0.125, 1.0625]);
    // SMA(2,1): -2; (-1-2)/2; (0-1.5)/2; (1-.75)/2.
    expect(values("SMA(C-3,2,1)")).toEqual([-2, -1.5, -0.75, 0.125, 1.0625]);
    // [-2,-1,0]: squared deviations 1+0+1, divide by 2 -> STD=1.
    expect(values("STD(C-3,3)")).toEqual([null, null, 1, 1, 1]);
  });
  it("recursive null inputs hold the previous valid state without resetting", () => {
    const expected = [-1, -1, 1, 1, 3];
    expect(emaSeries([-1, null, 3, null, 5], 3)).toEqual(expected);
    expect(smaSeries([-1, null, 3, null, 5], 2, 1)).toEqual(expected);
    expect(values("EMA(IF(C=2,1/0,C-2),3)")).toEqual([-1, -1, 0, 1, 2]);
    expect(values("EMA(REF(C,2),3)")).toEqual([null, null, 1, 1.5, 2.25]);
    expect(stdSeries([1, null, 3, 4], 2)).toEqual([
      null,
      null,
      null,
      Math.sqrt(0.5),
    ]);
  });
  it.each([
    ["HHV(C,3)", [null, null, 3, 4, 5]],
    ["LLV(C,3)", [null, null, 1, 2, 3]],
    ["SUM(C,3)", [null, null, 6, 9, 12]],
    ["COUNT(C>2,3)", [null, null, 1, 2, 3]],
    ["EXIST(C>3,2)", [null, 0, 0, 1, 1]],
    ["ABS(C-3)", [2, 1, 0, 1, 2]],
    ["MAX(C,3)", [3, 3, 3, 4, 5]],
    ["MIN(C,3)", [1, 2, 3, 3, 3]],
    ["IF(C>3,1,0)", [0, 0, 0, 1, 1]],
    ["CROSS(C,3)", [null, 0, 0, 1, 0]],
    ["BARSLAST(C=2)", [null, 0, 1, 2, 3]],
    ["FILTER(C>0,2)", [1, 0, 0, 1, 0]],
    ["LAST(C>1,2,1)", [null, null, 0, 1, 1]],
    ["LAST(C>0,0,0)", [1, 1, 1, 1, 1]],
    ["SUM(REF(C,1),0)", [null, 1, 3, 6, 10]],
    ["COUNT(REF(C,1)>1,0)", [null, 0, 1, 2, 3]],
    ["HHV(REF(C,1),0)", [null, 1, 2, 3, 4]],
    ["LLV(C,0)", [1, 1, 1, 1, 1]],
  ])("%s", (source, expected) => expect(values(source)).toEqual(expected));
  it("propagates unknowns and does not replace missing history with false", () => {
    expect(values("0 AND REF(C,2)")).toEqual([null, null, 0, 0, 0]);
    expect(values("1 OR REF(C,2)")).toEqual([null, null, 1, 1, 1]);
    expect(values("COUNT(REF(C,2),2)")).toEqual([null, null, null, 2, 2]);
    expect(values("IF(1,1,1/0)")).toEqual([1, 1, 1, 1, 1]);
    expect(values("C/0")).toEqual([null, null, null, null, null]);
    expect(values("FILTER(IF(C=1,1/0,1),2)")).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(values("BARSLAST(IF(C=2,1/0,C=1))")).toEqual([
      0,
      null,
      null,
      null,
      null,
    ]);
  });
  it("supports empty, single bar, nonfinite data and zero volume", () => {
    expect(values("EMA(C,3)", [])).toEqual([]);
    expect(values("STD(C,3)", bars([1]))).toEqual([null]);
    expect(values("C", bars([NaN]))).toEqual([null]);
    expect(values("V", [{ ...bars([1])[0]!, volume: 0 }])).toEqual([0]);
  });
  it("safe variable REF is causal and params are statically folded", () => {
    expect(values("距离:=BARSLAST(C=2);REF(C,距离)")).toEqual([
      null,
      2,
      2,
      2,
      2,
    ]);
    expect(values("距离:=IF(C>2,1,0);REF(C,距离)")).toEqual([1, 2, 2, 3, 4]);
    expect(values("周期:=N1+1;MA(C,周期)", bars([1, 2, 3]), { N1: 1 })).toEqual(
      [null, 1.5, 2.5],
    );
  });
  it("preserves historical outputs when future bars are appended, deterministic and no mutation", () => {
    // LOW/L is reserved market data; use a legal output name so the invariant runs.
    const source =
      "A:=EMA(C,3);M:MA(C,2);E:A;S:SMA(C,3,1);D:STD(C,2);R:REF(C,BARSLAST(C>3));F:FILTER(C>3,2);持续:LAST(C>0,0,0);";
    const data = bars([1, 2, 4, 3, 5]),
      snapshot = structuredClone(data);
    const before = evaluateFormula(source, data);
    const after = evaluateFormula(source, [...data, ...bars([99, 1, 300])]);
    for (let i = 0; i < before.outputs.length; i++)
      expect(after.outputs[i]!.values.slice(0, data.length)).toEqual(
        before.outputs[i]!.values,
      );
    expect(evaluateFormula(source, data)).toEqual(before);
    expect(data).toEqual(snapshot);
  });
  it("every prefix is stable across interleaved calls with frozen bars and parameters", () => {
    const source =
      "平滑:EMA(C,N1);均线:MA(C,2);标准差:STD(C,2);最高:HHV(REF(C,2),0);最低:LLV(C,3);累加:SUM(C,0);计数:COUNT(C>2,0);曾经:EXIST(C>3,2);交叉:CROSS(C,3);距离:BARSLAST(C>3);引用:REF(C,BARSLAST(C>3));过滤:FILTER(C>3,2);持续:LAST(REF(C,2)>0,0,0);";
    const data = Object.freeze(
      bars([1, 2, 4, 3, 5, 1, 99, 2]).map((b) => Object.freeze(b)),
    );
    const parameters = Object.freeze({ N1: 3 });
    const full = evaluateFormula(source, data, parameters);
    for (let length = 0; length <= data.length; length++) {
      const prefix = Object.freeze(data.slice(0, length));
      const before = evaluateFormula(source, prefix, parameters);
      evaluateFormula(source, bars([300, 1, 20]), { N1: 5 });
      expect(evaluateFormula(source, prefix, parameters)).toEqual(before);
      for (let i = 0; i < full.outputs.length; i++)
        expect(before.outputs[i]!.values).toEqual(
          full.outputs[i]!.values.slice(0, length),
        );
    }
    expect(parameters).toEqual({ N1: 3 });
  });
});

describe("static future gate", () => {
  it.each(futureFunctions)(
    "rejects %s even in a dead branch before reading input",
    (name) => {
      const data = new Proxy([] as Bar[], {
        get() {
          throw new Error("BARS WERE READ");
        },
      });
      try {
        evaluateFormula(
          `X:=1;\n忽略:=IF(0,${name.toLowerCase()}(C,1),0);\nX;`,
          data,
        );
        throw new Error("accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(FormulaError);
        expect((error as FormulaError).issues).toContainEqual(
          expect.objectContaining({ name, line: 2, kind: "future" }),
        );
      }
    },
  );
  it.each([
    "REF(C,-1)",
    "REF(C,1-3)",
    "N:=1;REF(C,-N)",
    "偏移:=IF(C>0,1,-1);REF(C,偏移)",
    "REF(C,C-2)",
    "REF(C,BARSLAST(C>0)-1)",
    "REF(C,N1)",
    "REF(C,1/0)",
    "REF(C,0.5)",
    "REF(C,MAX(C,-1))",
  ])("rejects negative or unprovable offsets %s", (source) =>
    expect(() => values(source, bars([5, 6]), { N1: -1 })).toThrow(
      /REF.*拒绝执行/,
    ),
  );
  it("rejects endpoint series without parentheses and cross-period references", () => {
    expect(() => values("X:=1;\nCURRBARSCOUNT")).toThrow("第2行 CURRBARSCOUNT");
    expect(() => values("X:=1;\nC#WEEK")).toThrow("第2行 #");
    expect(() => values("REFV(C,-1)")).toThrow("REFV");
  });
  it("comments are not calls, and unsupported data functions are always explicit", () => {
    expect(values("{ ZIG(C,3) } 1")).toEqual([1, 1, 1, 1, 1]);
    expect(() => values("IF(0,FINANCE(42),1)")).toThrow("FINANCE：函数不支持");
    expect(() => values("DYNAINFO(8)")).toThrow("DYNAINFO：函数不支持");
  });
});

describe("tdx-doc real condition formulas", () => {
  const oldDuck = readFileSync(
    new URL("./fixtures/q2a-old-duck.tdx", import.meta.url),
    "utf8",
  );
  it("parses ALL fourteen original old-duck statements; rejects BOTH unsupported calls", () => {
    expect(parseFormula(oldDuck)).toHaveLength(14);
    try {
      evaluateFormula(oldDuck, bars([1, 2, 3]));
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).issues).toEqual([
        {
          line: 12,
          name: "FINANCE",
          kind: "unsupported",
          reason: "函数不支持",
        },
        {
          line: 13,
          name: "DYNAINFO",
          kind: "unsupported",
          reason: "函数不支持",
        },
      ]);
    }
  });
  it("evaluates the EXPLICIT technical-only old-duck fixture, including a positive signal", () => {
    // Original technical prefix retained verbatim. This is NOT the original
    // selection formula: FINANCE/DYNAINFO have no substitute and full evaluation fails.
    const technical = oldDuck.split("FXG:=")[0]! + "LYT;";
    // Sustained uptrend -> five-day shallow pullback -> price/volume recovery.
    const closes = [
      ...Array.from({ length: 70 }, (_, i) => 10 + i * 0.2),
      23,
      22.8,
      22.6,
      22.4,
      22.2,
      24,
    ];
    // A lower wick at 74 approaches EMA55 without changing close-based A1/A2/A4/A5/A6.
    // EMA55[74]=19.462006044..., so 21/EMA55[74]-1=0.079025459 <= 0.1.
    // The original low=22.1 left A3 false (minimum at 75 was > 0.1).
    const data = bars(closes).map((b, i) => ({
      ...b,
      low: i === 74 ? 21 : b.close - 0.1,
      volume: i === 75 ? 2000 : 1000,
    }));
    const out = values(technical, data);
    // REF is unknown at 0; COUNT(...,13) first has 13 valid inputs at index 13.
    expect(out.slice(0, 13)).toEqual(Array(13).fill(null));
    expect(out.filter((x) => x === 1)).toHaveLength(1);
    expect(out[75]).toBe(1);
    expect(out.slice(13, 75)).toEqual(Array(62).fill(0));
    const conditions = evaluateFormula(
      oldDuck.split("FXG:=")[0]! + "A1;A2;A3;A4;A5;A6;A7;",
      data,
    ).outputs;
    expect(conditions.map((o) => o.values[75])).toEqual([1, 1, 1, 1, 1, 1, 1]);
    // Negative control: restore the original wick, and only A3 fails on signal day.
    const original = data.map((b, i) =>
      i === 74 ? { ...b, low: b.close - 0.1 } : b,
    );
    expect(values(technical, original).filter((x) => x === 1)).toHaveLength(0);
    expect(
      evaluateFormula(
        oldDuck.split("FXG:=")[0]! + "A1;A2;A3;A4;A5;A6;A7;",
        original,
      ).outputs.map((o) => o.values[75]),
    ).toEqual([1, 1, 0, 1, 1, 1, 1]);
  });
  it("the real Buffett formula reports every financial call with names/lines", () => {
    const source =
      "A1:=(FINANCE(20)-FINANCE(21))/FINANCE(20)*100>N1;\nA2:=FINANCE(30)/FINANCE(20)*100>N2;\nA3:=FINANCE(30)/FINANCE(19)*100>N3;\nA1 AND A2 AND A3;";
    expect(() => evaluateFormula(source, [], { N1: 1, N2: 2, N3: 3 })).toThrow(
      "FINANCE：函数不支持",
    );
  });
});
