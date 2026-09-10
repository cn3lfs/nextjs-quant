import { describe, expect, it } from "vitest";
import { evaluateFormula, futureFunctions } from "../src/lib/tdx-formula";
import { arities } from "../src/lib/tdx-formula-check";
import type { Bar } from "../src/lib/domain";
const bars = [1,2,3,4].map((close,i): Bar => ({date:`2026-01-0${i+1}`,open:close,high:close+1,low:close-1,close,volume:100,amount:close*100}));
// Independent arithmetic expectations on [1,2,3,4]. Window3=[2,3,4],
// mean=3, squared deviations=2, absolute deviations=2, slope=1.
// DMA(.5): 1,1.5,2.25,3.125; TMA(.5,.25):1,1,1.25,1.625.
const additions: [string,string,number][] = [
  ["WMA","WMA(C,3)",20/6], ["DMA","DMA(C,0.5)",3.125], ["TMA","TMA(C,0.5,0.25)",1.625],
  ["HHVBARS","HHVBARS(C,3)",0], ["LLVBARS","LLVBARS(C,3)",2], ["BARSCOUNT","BARSCOUNT(C)",4],
  ["AVEDEV","AVEDEV(C,3)",2/3], ["SLOPE","SLOPE(C,3)",1], ["STDP","STDP(C,3)",Math.sqrt(2/3)], ["VAR","VAR(C,3)",1],
  ["INTPART","INTPART(-C/3)",-1], ["ROUND","ROUND(-C+0.5)",-4], ["POW","POW(C,2)",16], ["SQRT","SQRT(C)",2],
  ["LOG","LOG(C*25)",2], ["MOD","MOD(C,3)",1], ["SGN","SGN(-C)",-1],
  ["BETWEEN","BETWEEN(C,4,2)",1], ["VALUEWHEN","VALUEWHEN(C<3,C)",2], ["RANGE","RANGE(C,2,4)",0], ["IFF","IFF(C>3,8,9)",8],
  ["EVERY","EVERY(C>1,3)",1], ["IFN","IFN(C>3,8,9)",9], ["CEILING","CEILING(-C/3)",-1], ["FLOOR","FLOOR(-C/3)",-2],
  ["FRACPART","FRACPART(-C/3)",-1/3], ["SIGN","SIGN(C)",1], ["EXP","EXP(C-4)",1], ["LN","LN(C/4)",0],
  ["SIN","SIN(C-4)",0], ["COS","COS(C-4)",1], ["TAN","TAN(C-4)",0], ["ASIN","ASIN(C-4)",0], ["ACOS","ACOS(C/4)",0], ["ATAN","ATAN(C-4)",0],
  ["MEMA","MEMA(C,2)",3.125], ["EXPMA","EXPMA(C,3)",3.125], ["VARP","VARP(C,3)",2/3], ["DEVSQ","DEVSQ(C,3)",2],
];
describe("Q2b every new function", () => {
  it("has exactly 60 callable functions and 39 newly covered names, no market alias inflation", () => {
    expect(Object.keys(arities)).toHaveLength(60);
    expect(new Set(additions.map(([name]) => name)).size).toBe(39);
    for(const [name] of additions) expect(arities).toHaveProperty(name);
  });
  it.each(additions)("%s: hand-checkable value, causal prefix, determinism, immutable input and hard future gate", (_name,expr,expected) => {
    const source = `结果:${expr};`;
    const input = Object.freeze(bars.map(b => Object.freeze({...b})));
    const params = Object.freeze({N1:3});
    const before = JSON.stringify(input);
    const a = evaluateFormula(source,input,params);
    expect(a.outputs[0]!.values.at(-1)).toBeCloseTo(expected,10);
    expect(evaluateFormula(source,input,params)).toEqual(a);
    const extended = [...input,{...bars[0]!,date:"2026-01-05",close:999},{...bars[0]!,date:"2026-01-06",close:0}];
    expect(evaluateFormula(source,extended,params).outputs[0]!.values.slice(0,4)).toEqual(a.outputs[0]!.values);
    expect(JSON.stringify(input)).toBe(before);
    expect(evaluateFormula(source,[],params).outputs[0]!.values).toEqual([]);
    for (const future of futureFunctions) {
      // Even an unused assignment is rejected before evaluating the new function.
      expect(() => evaluateFormula(`坏:= ${future}(C,3,1);\n${source}`,input,params)).toThrow(`第1行 ${future}`);
    }
    expect(() => evaluateFormula(`${source}\n坏:=REF(C,-1);`,input,params)).toThrow("第2行 REF");
  });
  it("preserves full windows, population N=1, null domains and recursive gap state", () => {
    const out = (expr:string) => evaluateFormula(expr,bars).outputs[0]!.values;
    expect(out("WMA(C,3)")).toEqual([null,null,14/6,20/6]);
    expect(out("STDP(C,1)")).toEqual([0,0,0,0]);
    expect(out("VAR(C,3)")).toEqual([null,null,1,1]);
    for (const expr of ["SQRT(-C)","LOG(0)","LN(-1)","MOD(C,0)","ASIN(2)","ACOS(-2)","EXP(9999)"]) expect(out(expr)).toEqual([null,null,null,null]);
    expect(out("DMA(IF(C=2,C/0,C),0.5)")).toEqual([1,1,2,3]);
    expect(out("TMA(IF(C=2,C/0,C),0.5,0.25)")).toEqual([1,1,1.25,1.625]);
    expect(out("BARSCOUNT(REF(C,2))")).toEqual([null,null,1,2]);
    expect(out("VALUEWHEN(C>10,C)")).toEqual([null,null,null,null]);
    expect(out("HHVBARS(1,0)")).toEqual([0,0,0,0]);
    expect(out("LLVBARS(1,0)")).toEqual([0,0,0,0]);
  });
  it("rejects unsupported signatures, invalid weights and hidden future offsets without approximation", () => {
    for (const expr of ["DMA(C,1)","DMA(C,0)","TMA(C,1,0.5)","TMA(C,C,0.5)","WMA(C,0)","VAR(C,1)","SLOPE(C,1)","EVERY(C,C)"])
      expect(() => evaluateFormula(expr,[])).toThrow();
    expect(() => evaluateFormula("DMA(C,C/4)",bars)).toThrow("第1行 DMA");
    expect(() => evaluateFormula("REF(C,IFF(C>1,1,-1))",bars)).toThrow("REF");
    expect(() => evaluateFormula("RAND(10)",bars)).toThrow("第1行 RAND");
    expect(() => evaluateFormula("WMA(C,C)",bars)).toThrow("静态整数");
  });
});
