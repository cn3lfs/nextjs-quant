import type { Bar } from "./domain";
import {
  emaSeries,
  maSeries,
  smaSeries,
  stdSeries,
  type IndicatorValue,
} from "./indicators";
import {
  binary,
  checkFormula,
  marketFields,
  unary,
  isRpsField,
  rpsFields,
} from "./tdx-formula-check";
import type { RpsValue } from "./rps";
import { FormulaError, parseFormula, type Expr } from "./tdx-formula-syntax";
export { FormulaError, parseFormula } from "./tdx-formula-syntax";
export { futureFunctions } from "./tdx-formula-check";
type Series = IndicatorValue[];
export type FormulaRpsPoint = {
  date: string;
  periods: readonly number[];
  values: readonly (RpsValue | null)[];
};
const finite = (n: number): IndicatorValue => (Number.isFinite(n) ? n : null);

/** Pure language core. Explicit, ascending, completed, unadjusted input bars.
 * No I/O, eval or generated JS. Q2b worker consumes this exact evaluator.
 * Validation always precedes reading bars, even for an empty input.
 */
export function evaluateFormula(
  source: string,
  bars: readonly Bar[],
  parameters: Readonly<Record<string, number>> = {},
  rps: readonly FormulaRpsPoint[] = [],
) {
  const program = parseFormula(source);
  const params = checkFormula(program, parameters);
  const rpsByDate = new Map(rps.map((point) => [point.date, point]));
  const variables = new Map<string, Series>();
  const constant = (n: number): Series =>
    Array.from({ length: bars.length }, () => n);
  for (const [name, value] of params) variables.set(name, constant(value));
  const map = (a: Series, f: (x: number) => number): Series =>
    a.map((x) => (x === null ? null : finite(f(x))));
  const zip = (
    a: Series,
    b: Series,
    f: (x: number, y: number) => number,
  ): Series =>
    a.map((x, i) => (x === null || b[i] === null ? null : finite(f(x, b[i]!))));
  // Full window required. For N=0 (COUNT: N<=0), begin at first valid input;
  // interior nulls remain unknown, never count as false or get filled with zero.
  const windowed = (
    a: Series,
    n: number,
    f: (values: number[]) => number,
  ): Series => {
    const first = a.findIndex((v) => v !== null);
    return a.map((_, i) => {
      const start = n <= 0 ? first : i + 1 - n;
      if (start < 0 || start > i) return null;
      const window = a.slice(start, i + 1);
      return window.some((v) => v === null)
        ? null
        : finite(f(window as number[]));
    });
  };
  function evaluate(e: Expr): Series {
    if (e.kind === "string") throw new Error("Unvalidated string");
    if (e.kind === "number") return constant(e.value);
    if (e.kind === "name") {
      if (isRpsField(e.name)) {
        const period = rpsFields[e.name];
        // Exact date only: missing batches, excluded stocks and insufficient
        // endpoints stay unknown. Never carry forward or replace with zero.
        return bars.map((bar) => {
          const point = rpsByDate.get(bar.date);
          const value = point?.values[point.periods.indexOf(period)]?.rps;
          return value == null ? null : finite(value);
        });
      }
      const field = Object.hasOwn(marketFields, e.name)
        ? marketFields[e.name]
        : undefined;
      return field ? bars.map((b) => finite(b[field])) : variables.get(e.name)!;
    }
    if (e.kind === "unary")
      return map(evaluate(e.value), (x) => unary(e.op, x));
    if (e.kind === "binary")
      return zip(evaluate(e.left), evaluate(e.right), (x, y) =>
        binary(e.op, x, y),
      );
    const args = e.args.map(evaluate),
      a = args[0]!,
      b = args[1]!;
    // Parameters have been proved constant statically. Empty input needs no
    // numeric period lookup, but still went through the complete static gate.
    if (!bars.length) return [];
    const n = b?.[0] as number;
    switch (e.name) {
      case "MA":
        return maSeries(a, n);
      case "EMA":
      case "EXPMA":
        return emaSeries(a, n);
      case "MEMA":
        return smaSeries(a, n, 1);
      case "SMA":
        return smaSeries(a, n, args[2]![0]!);
      case "STD":
        return stdSeries(a, n);
      // tdx-doc 引用函数 WMA/DMA/TMA. Recursive gaps retain state (M1).
      case "WMA":
        return windowed(
          a,
          n,
          (v) =>
            v.reduce((sum, x, i) => sum + x * (i + 1), 0) / ((n * (n + 1)) / 2),
        );
      case "DMA":
      case "TMA": {
        let previous: IndicatorValue = null;
        return a.map((x, i) => {
          const weight = b[i];
          if (
            e.name === "DMA" &&
            weight !== null &&
            !(weight! > 0 && weight! < 1)
          )
            throw new FormulaError([
              {
                line: e.line,
                name: e.name,
                kind: "parameter",
                reason: "DMA 要求每根有效 A 满足 0<A<1",
              },
            ]);
          if (x === null || weight === null) return previous;
          const next =
            previous === null
              ? x
              : finite(
                  e.name === "DMA"
                    ? weight! * x + (1 - weight!) * previous
                    : weight! * previous + args[2]![i]! * x,
                );
          if (next !== null) previous = next;
          return previous;
        });
      }
      case "HHVBARS":
      case "LLVBARS":
        return windowed(a, n, (v) => {
          // Equal extrema choose the most recent occurrence, never a future tie.
          const best = v.reduce((x, y) =>
            e.name === "HHVBARS" ? Math.max(x, y) : Math.min(x, y),
          );
          return v.length - 1 - v.lastIndexOf(best);
        });
      case "BARSCOUNT": {
        let first: number | null = null;
        return a.map((x, i) => {
          if (first === null && x !== null) first = i;
          return first === null ? null : i - first + 1;
        });
      }
      // 统计函数: sample variance shares M1 STD; population uses the same
      // shared mean and full-window/null contract. N=1 population variance is 0.
      case "VAR":
        return map(stdSeries(a, n), (x) => x * x);
      case "STDP":
      case "VARP":
      case "DEVSQ":
      case "AVEDEV":
      case "SLOPE": {
        const means = maSeries(a, n);
        return means.map((mid, i) => {
          if (mid === null) return null;
          const v = a.slice(i + 1 - n, i + 1) as number[];
          const sq = v.reduce((sum, x) => sum + (x - mid) ** 2, 0);
          if (e.name === "STDP") return finite(Math.sqrt(sq / n));
          if (e.name === "VARP") return finite(sq / n);
          if (e.name === "DEVSQ") return finite(sq);
          if (e.name === "AVEDEV")
            return finite(v.reduce((sum, x) => sum + Math.abs(x - mid), 0) / n);
          const center = (n - 1) / 2;
          return finite(
            v.reduce((sum, x, j) => sum + (j - center) * (x - mid), 0) /
              ((n * (n * n - 1)) / 12),
          );
        });
      }
      case "REF":
        return a.map((_, i) => {
          const offset = b[i];
          return offset == null ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            i < offset
            ? null
            : a[i - offset]!;
        });
      case "HHV":
        return windowed(a, n, (values) =>
          values.reduce((x, y) => Math.max(x, y)),
        );
      case "LLV":
        return windowed(a, n, (values) =>
          values.reduce((x, y) => Math.min(x, y)),
        );
      case "SUM":
        return windowed(a, n, (values) => values.reduce((x, y) => x + y, 0));
      case "COUNT":
        return windowed(a, n, (values) => values.filter((x) => x !== 0).length);
      case "EXIST":
        return windowed(a, n, (values) => +values.some((x) => x !== 0));
      case "EVERY":
        return windowed(a, n, (values) => +values.every((x) => x !== 0));
      case "ABS":
        return map(a, Math.abs);
      case "NOT":
        return map(a, (x) => +(x === 0));
      case "MAX":
        return zip(a, b, Math.max);
      case "MIN":
        return zip(a, b, Math.min);
      // tdx-doc 数学函数. ROUND ties away from zero; MOD signed remainder.
      // Undefined domains/overflow use null, never a numeric approximation.
      case "INTPART":
        return map(a, Math.trunc);
      case "ROUND":
        return map(a, (x) => Math.sign(x) * Math.round(Math.abs(x)));
      case "CEILING":
        return map(a, Math.ceil);
      case "FLOOR":
        return map(a, Math.floor);
      case "FRACPART":
        return map(a, (x) => x - Math.trunc(x));
      case "SGN":
      case "SIGN":
        return map(a, Math.sign);
      case "SQRT":
        return map(a, Math.sqrt);
      case "LOG":
        return map(a, Math.log10);
      case "LN":
        return map(a, Math.log);
      case "EXP":
        return map(a, Math.exp);
      case "SIN":
        return map(a, Math.sin);
      case "COS":
        return map(a, Math.cos);
      case "TAN":
        return map(a, Math.tan);
      case "ASIN":
        return map(a, Math.asin);
      case "ACOS":
        return map(a, Math.acos);
      case "ATAN":
        return map(a, Math.atan);
      case "POW":
        return zip(a, b, Math.pow);
      case "MOD":
        return zip(a, b, (x, y) => (y === 0 ? NaN : x % y));
      case "BETWEEN":
      case "RANGE":
        return a.map((x, i) => {
          const lo = b[i],
            hi = args[2]![i];
          return x == null || lo == null || hi == null
            ? null
            : e.name === "BETWEEN"
              ? +(Math.min(lo, hi) <= x && x <= Math.max(lo, hi))
              : +(lo < x && x < hi);
        });
      case "VALUEWHEN": {
        let previous: IndicatorValue = null;
        return a.map((x, i) => {
          if (x === null) previous = null;
          else if (x !== 0) previous = b[i]!;
          return previous;
        });
      }
      case "AND":
      case "OR":
        return zip(a, b, (x, y) => binary(e.name, x, y));
      case "IFN":
        return a.map((x, i) =>
          x === null ? null : x !== 0 ? args[2]![i]! : b[i]!,
        );
      case "IF":
      case "IFF":
        return a.map((x, i) =>
          x === null ? null : x !== 0 ? b[i]! : args[2]![i]!,
        );
      // Equality on the previous bar belongs to the lower side of an up-cross.
      case "CROSS":
        return a.map((x, i) =>
          i === 0 ||
          x === null ||
          b[i] === null ||
          a[i - 1] === null ||
          b[i - 1] === null
            ? null
            : +(a[i - 1]! <= b[i - 1]! && x > b[i]!),
        );
      case "BARSLAST": {
        let last: number | null = null;
        return a.map((x, i) => {
          if (x === null) {
            last = null;
            return null;
          }
          if (x !== 0) last = i;
          return last === null ? null : i - last;
        });
      }
      case "FILTER": {
        // Track all possible remaining suppression lengths through unknown
        // inputs. This prevents a null in the past fabricating a later signal.
        let low = 0,
          high = 0;
        return a.map((x) => {
          const canEmit = low === 0,
            canSuppress = high > 0;
          const emit = x !== 0 && canEmit;
          const suppress = (x !== null && x === 0) || canSuppress;
          const result =
            x === null ? null : emit && suppress ? null : emit ? 1 : 0;
          const next: number[] = [];
          if (canSuppress) {
            next.push(Math.max(0, low - 1), high - 1);
          }
          if (canEmit) {
            if (x !== 0) next.push(n);
            if (x === null || x === 0) next.push(0);
          }
          low = Math.min(...next);
          high = Math.max(...next);
          return result;
        });
      }
      case "LAST": {
        const end = args[2]![0]!,
          first = a.findIndex((v) => v !== null);
        return a.map((_, i) => {
          const start = n === 0 ? first : i - n,
            stop = i - end;
          if (start < 0 || stop < start) return null;
          const values = a.slice(start, stop + 1);
          return values.some((v) => v === null)
            ? null
            : +values.every((v) => v !== 0);
        });
      }
      default:
        throw new Error("Unvalidated function");
    }
  }
  const outputs: { name: string; line: number; values: Series }[] = [];
  for (const statement of program) {
    const values = evaluate(statement.expr);
    if (statement.name) variables.set(statement.name, values);
    if (statement.output)
      outputs.push({
        name: statement.name ?? `$${outputs.length + 1}`,
        line: statement.line,
        values,
      });
  }
  return { outputs };
}
