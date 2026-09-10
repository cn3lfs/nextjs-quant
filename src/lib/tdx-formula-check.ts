import { FormulaError, type Expr, type FormulaIssue, type Statement } from "./tdx-formula-syntax";

// Sources: tdx-doc functions/{引用函数,形态函数,序列行情函数,绘图函数}.md.
// The first group is explicitly marked future by the dictionary. The second
// repaints/depends on the final bar; the last group is conservatively denied in
// all forms until parameter semantics are implemented. Unknown calls also fail.
export const futureFunctions = [
  "ZIG", "ZIGA", "PEAK", "PEAKBARS", "TROUGH", "TROUGHBARS",
  "BACKSET", "BARSNEXT", "REFX", "REFXV", "XMA", "DRAWLINE",
  "DHIGH", "DOPEN", "DLOW", "DCLOSE", "DVOL",
  "FILTERX", "REFDATE", "CONST", "ALIGNRIGHT", "CURRBARSCOUNT",
  "TOTALBARSCOUNT", "ISLASTBAR", "BARSTATUS", "IFC", "TESTSKIP",
  "FINDHIGH", "FINDHIGHBARS", "FINDLOW", "FINDLOWBARS",
] as const;
const future = new Set<string>(futureFunctions);
export const marketFields: Readonly<Record<string, "close" | "open" | "high" | "low" | "volume" | "amount">> = {
  C: "close", CLOSE: "close", O: "open", OPEN: "open", H: "high", HIGH: "high",
  L: "low", LOW: "low", V: "volume", VOL: "volume", AMOUNT: "amount",
};
export const arities: Readonly<Record<string, number>> = {
  REF: 2, MA: 2, EMA: 2, SMA: 3, HHV: 2, LLV: 2, SUM: 2, COUNT: 2,
  CROSS: 2, BARSLAST: 1, FILTER: 2, LAST: 3, EXIST: 2,
  IF: 3, AND: 2, OR: 2, NOT: 1, ABS: 1, MAX: 2, MIN: 2, STD: 2,
};
export function binary(op: string, a: number, b: number): number {
  switch (op) {
    case "+": return a + b; case "-": return a - b;
    case "*": return a * b; case "/": return b === 0 ? NaN : a / b;
    case ">": return +(a > b); case "<": return +(a < b);
    case ">=": return +(a >= b); case "<=": return +(a <= b);
    case "=": return +(a === b); case "<>": case "!=": return +(a !== b);
    case "AND": case "&&": return +(a !== 0 && b !== 0);
    case "OR": case "||": return +(a !== 0 || b !== 0);
    default: throw new Error("Unknown operator");
  }
}
export function unary(op: string, a: number) { return op === "NOT" ? +(a === 0) : op === "-" ? -a : a; }
type Range = { min: number; max: number; integer: boolean; constant?: number };
const unknown: Range = {min: -Infinity, max: Infinity, integer: false};
const truth: Range = {min: 0, max: 1, integer: true};
const exact = (n: number): Range => Number.isFinite(n) ? {min: n, max: n, integer: Number.isSafeInteger(n), constant: n} : unknown;
const scalar = (r: Range | undefined) => r?.constant;

/** Checks the entire program BEFORE any bar is read, including dead branches and
 * unused assignments. REF variable offsets require proof of nonnegative integer
 * range, not examination of the current sample. Unprovable means refusal.
 */
export function checkFormula(statements: readonly Statement[], parameters: Readonly<Record<string, number>> = {}) {
  const issues: FormulaIssue[] = [];
  const names = new Map<string, Range>();
  const params = new Map<string, number>();
  for (const [name, value] of Object.entries(parameters)) {
    const key = name.toUpperCase();
    if (!/^N[1-9]\d*$/.test(key) || !Number.isFinite(value) || params.has(key)) {
      issues.push({line: 1, name, kind: "parameter", reason: "参数须为唯一 N1/N2… 名称及有限数值"});
    } else { params.set(key, value); names.set(key, exact(value)); }
  }
  const report = (expr: Expr, kind: FormulaIssue["kind"], reason: string, name?: string) => issues.push({line: expr.line, name, kind, reason});
  function visit(e: Expr): Range {
    if (e.kind === "number") return exact(e.value);
    if ((e.kind === "name" || e.kind === "call") && future.has(e.name)) {
      report(e, "future", "未来函数或无法保证因果性的形式，拒绝执行", e.name);
    }
    if (e.kind === "name") {
      if (future.has(e.name)) return unknown;
      if (Object.hasOwn(marketFields, e.name)) return unknown;
      const value = names.get(e.name);
      if (!value) report(e, "parameter", "变量未定义或参数未提供", e.name);
      return value ?? unknown;
    }
    if (e.kind === "unary") {
      const r = visit(e.value), n = scalar(r);
      if (n !== undefined) return exact(unary(e.op, n));
      return e.op === "NOT" ? truth : e.op === "-" ? {min: -r.max, max: -r.min, integer: r.integer} : r;
    }
    if (e.kind === "binary") {
      const a = visit(e.left), b = visit(e.right), x = scalar(a), y = scalar(b);
      if (x !== undefined && y !== undefined) return exact(binary(e.op, x, y));
      if (!["+", "-", "*", "/"].includes(e.op)) return truth;
      if (e.op === "+") return {min: a.min + b.min, max: a.max + b.max, integer: a.integer && b.integer};
      if (e.op === "-") return {min: a.min - b.max, max: a.max - b.min, integer: a.integer && b.integer};
      return unknown;
    }
    const args = e.args.map(visit);
    if (future.has(e.name)) return unknown;
    if (!Object.hasOwn(arities, e.name)) {
      report(e, "unsupported", "函数不支持", e.name); return unknown;
    }
    if (args.length !== arities[e.name]) {
      report(e, "parameter", `需要 ${arities[e.name]} 个参数，实际 ${args.length} 个`, e.name); return unknown;
    }
    if (e.name === "REF") {
      const n = args[1]!;
      if (!(n.min >= 0 && n.integer)) report(e, "future", "REF 偏移为负数或无法静态证明为非负整数，拒绝执行", e.name);
      return {...args[0]!, constant: undefined};
    }
    const periodPositions = e.name === "SMA" || e.name === "LAST" ? [1, 2]
      : ["MA", "EMA", "HHV", "LLV", "SUM", "COUNT", "FILTER", "EXIST", "STD"].includes(e.name) ? [1] : [];
    for (const pos of periodPositions) {
      const n = scalar(args[pos]);
      const minimum = e.name === "STD" ? 2 : ["MA", "EMA", "SMA", "EXIST"].includes(e.name) ? 1 : e.name === "COUNT" ? -Infinity : 0;
      if (n === undefined || !Number.isSafeInteger(n) || n < minimum)
        report(e, "parameter", `第${pos + 1}参数须为静态整数且 >= ${minimum}`, e.name);
    }
    if (e.name === "SMA" && scalar(args[2])! > scalar(args[1])!) report(e, "parameter", "SMA 要求 M <= N", e.name);
    if (e.name === "LAST" && scalar(args[1]) !== 0 && scalar(args[1])! < scalar(args[2])!) report(e, "parameter", "LAST 要求 A >= B（A=0 表示从首个有效值）", e.name);
    if (["AND", "OR", "NOT", "EXIST", "LAST", "CROSS", "FILTER"].includes(e.name)) return truth;
    if (e.name === "COUNT" || e.name === "BARSLAST") return {min: 0, max: Infinity, integer: true};
    if (e.name === "IF" && scalar(args[0]) !== undefined && scalar(args[1]) !== undefined && scalar(args[2]) !== undefined) return exact(scalar(args[0]) !== 0 ? scalar(args[1])! : scalar(args[2])!);
    if (e.name === "IF") return {min: Math.min(args[1]!.min, args[2]!.min), max: Math.max(args[1]!.max, args[2]!.max), integer: args[1]!.integer && args[2]!.integer};
    if (e.name === "ABS") {
      const r = args[0]!, n = scalar(r);
      return n !== undefined ? exact(Math.abs(n)) : {min: 0, max: Math.max(Math.abs(r.min), Math.abs(r.max)), integer: r.integer};
    }
    if (e.name === "MAX" || e.name === "MIN") {
      const fn = e.name === "MAX" ? Math.max : Math.min;
      if (scalar(args[0]) !== undefined && scalar(args[1]) !== undefined) return exact(fn(scalar(args[0])!, scalar(args[1])!));
      return {min: fn(args[0]!.min, args[1]!.min), max: fn(args[0]!.max, args[1]!.max), integer: args[0]!.integer && args[1]!.integer};
    }
    return unknown;
  }
  for (const s of statements) {
    const range = visit(s.expr);
    if (s.name) {
      if (names.has(s.name) || Object.hasOwn(marketFields, s.name) || Object.hasOwn(arities, s.name) || future.has(s.name) || /^N\d+$/.test(s.name))
        issues.push({line: s.line, name: s.name, kind: "parameter", reason: "名称重复或占用保留名称"});
      else names.set(s.name, range);
    }
  }
  if (issues.length) throw new FormulaError(issues);
  return params;
}
