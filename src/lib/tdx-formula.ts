import type { Bar } from "./domain";
import { emaSeries, maSeries, smaSeries, stdSeries, type IndicatorValue } from "./indicators";
import { binary, checkFormula, marketFields, unary } from "./tdx-formula-check";
import { parseFormula, type Expr } from "./tdx-formula-syntax";
export { FormulaError, parseFormula } from "./tdx-formula-syntax";
export { futureFunctions } from "./tdx-formula-check";
type Series = IndicatorValue[];
const finite = (n: number): IndicatorValue => Number.isFinite(n) ? n : null;

/** Q2a pure language core. Explicit, ascending, completed, unadjusted input bars.
 * No I/O, eval, generated JS, persisted formulas or screening integration (Q2b).
 * Validation always precedes reading bars, even for an empty input.
 */
export function evaluateFormula(source: string, bars: readonly Bar[], parameters: Readonly<Record<string, number>> = {}) {
  const program = parseFormula(source);
  const params = checkFormula(program, parameters);
  const variables = new Map<string, Series>();
  const constant = (n: number): Series => Array.from({length: bars.length}, () => n);
  for (const [name, value] of params) variables.set(name, constant(value));
  const map = (a: Series, f: (x: number) => number): Series => a.map(x => x === null ? null : finite(f(x)));
  const zip = (a: Series, b: Series, f: (x: number, y: number) => number): Series =>
    a.map((x, i) => x === null || b[i] === null ? null : finite(f(x, b[i]!)));
  // Full window required. For N=0 (COUNT: N<=0), begin at first valid input;
  // interior nulls remain unknown, never count as false or get filled with zero.
  const windowed = (a: Series, n: number, f: (values: number[]) => number): Series => {
    const first = a.findIndex(v => v !== null);
    return a.map((_, i) => {
      const start = n <= 0 ? first : i + 1 - n;
      if (start < 0 || start > i) return null;
      const window = a.slice(start, i + 1);
      return window.some(v => v === null) ? null : finite(f(window as number[]));
    });
  };
  function evaluate(e: Expr): Series {
    if (e.kind === "number") return constant(e.value);
    if (e.kind === "name") {
      const field = Object.hasOwn(marketFields, e.name) ? marketFields[e.name] : undefined;
      return field ? bars.map(b => finite(b[field])) : variables.get(e.name)!;
    }
    if (e.kind === "unary") return map(evaluate(e.value), x => unary(e.op, x));
    if (e.kind === "binary") return zip(evaluate(e.left), evaluate(e.right), (x, y) => binary(e.op, x, y));
    const args = e.args.map(evaluate), a = args[0]!, b = args[1]!;
    // Parameters have been proved constant statically. Empty input needs no
    // numeric period lookup, but still went through the complete static gate.
    if (!bars.length) return [];
    const n = b?.[0] as number;
    switch (e.name) {
      case "MA": return maSeries(a, n);
      case "EMA": return emaSeries(a, n);
      case "SMA": return smaSeries(a, n, args[2]![0]!);
      case "STD": return stdSeries(a, n);
      case "REF": return a.map((_, i) => {
        const offset = b[i];
        return offset == null || !Number.isSafeInteger(offset) || offset < 0 || i < offset ? null : a[i - offset]!;
      });
      case "HHV": return windowed(a, n, values => values.reduce((x, y) => Math.max(x, y)));
      case "LLV": return windowed(a, n, values => values.reduce((x, y) => Math.min(x, y)));
      case "SUM": return windowed(a, n, values => values.reduce((x, y) => x + y, 0));
      case "COUNT": return windowed(a, n, values => values.filter(x => x !== 0).length);
      case "EXIST": return windowed(a, n, values => +values.some(x => x !== 0));
      case "ABS": return map(a, Math.abs);
      case "NOT": return map(a, x => +(x === 0));
      case "MAX": return zip(a, b, Math.max);
      case "MIN": return zip(a, b, Math.min);
      case "AND": case "OR": return zip(a, b, (x,y) => binary(e.name, x,y));
      case "IF": return a.map((x,i) => x === null ? null : x !== 0 ? b[i]! : args[2]![i]!);
      // Equality on the previous bar belongs to the lower side of an up-cross.
      case "CROSS": return a.map((x,i) => i === 0 || x === null || b[i] === null || a[i-1] === null || b[i-1] === null
        ? null : +(a[i-1]! <= b[i-1]! && x > b[i]!));
      case "BARSLAST": {
        let last: number | null = null;
        return a.map((x,i) => {
          if (x === null) { last = null; return null; }
          if (x !== 0) last = i;
          return last === null ? null : i-last;
        });
      }
      case "FILTER": {
        // Track all possible remaining suppression lengths through unknown
        // inputs. This prevents a null in the past fabricating a later signal.
        let low = 0, high = 0;
        return a.map(x => {
          const canEmit = low === 0, canSuppress = high > 0;
          const emit = x !== 0 && canEmit;
          const suppress = x !== null && x === 0 || canSuppress;
          const result = x === null ? null : emit && suppress ? null : emit ? 1 : 0;
          const next: number[] = [];
          if (canSuppress) { next.push(Math.max(0, low-1), high-1); }
          if (canEmit) { if (x !== 0) next.push(n); if (x === null || x === 0) next.push(0); }
          low = Math.min(...next); high = Math.max(...next);
          return result;
        });
      }
      case "LAST": {
        const end = args[2]![0]!, first = a.findIndex(v => v !== null);
        return a.map((_,i) => {
          const start = n === 0 ? first : i-n, stop = i-end;
          if (start < 0 || stop < start) return null;
          const values = a.slice(start, stop+1);
          return values.some(v => v === null) ? null : +values.every(v => v !== 0);
        });
      }
      default: throw new Error("Unvalidated function");
    }
  }
  const outputs: {name: string; line: number; values: Series}[] = [];
  for (const statement of program) {
    const values = evaluate(statement.expr);
    if (statement.name) variables.set(statement.name, values);
    if (statement.output) outputs.push({name: statement.name ?? `$${outputs.length+1}`, line: statement.line, values});
  }
  return {outputs};
}
