import type { Bar } from "trading-strategy-core/bars";
import { maSeries } from "trading-strategy-core/indicators";

/** The fixed MA5/10 research baseline, including formula CROSS null/equality semantics. */
export function researchMaCrossOutputs(bars: readonly Bar[]) {
  const close = bars.map((bar) =>
    Number.isFinite(bar.close) ? bar.close : null,
  );
  const fast = maSeries(close, 5),
    slow = maSeries(close, 10);
  const cross = (
    left: readonly (number | null)[],
    right: readonly (number | null)[],
  ) =>
    left.map((value, index) => {
      if (
        index === 0 ||
        value === null ||
        right[index] === null ||
        left[index - 1] === null ||
        right[index - 1] === null
      )
        return null;
      return +(left[index - 1]! <= right[index - 1]! && value > right[index]!);
    });
  return [{ values: cross(fast, slow) }, { values: cross(slow, fast) }];
}
