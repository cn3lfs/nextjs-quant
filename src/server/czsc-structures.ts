import type { CzscInput } from "./czsc-input";
import type { CzscProjections } from "./czsc";

// Decode DLL-selected boundaries; do not identify or extend centers in JS.
export function decodeCzscCenters(
  input: CzscInput,
  result: CzscProjections,
  config: number,
) {
  const p = (output: number) => result.projections[`${config}:${output}`]!;
  const points = p(0).flatMap((direction, index) =>
    direction === 0
      ? []
      : [
          {
            index,
            direction,
            price: Math.fround(
              direction > 0 ? input.high[index]! : input.low[index]!,
            ),
          },
        ],
  );
  const centers = p(3).flatMap((mark, start) => {
    if (mark !== 1) return [];
    const end = p(3).findIndex((v, i) => i >= start && v === 2);
    if (end < start) throw new Error("CZSC center has no end");
    const first = points.findIndex((point) => point.index === start);
    const members = points.filter(
      (point) => point.index >= start && point.index <= end,
    );
    if (first < 1 || members.length < 4)
      throw new Error("Invalid CZSC center endpoints");
    // CzscCenter.cpp: direction is the entering endpoint's opposite type;
    // GG/DD are the union of the selected endpoint intervals (CzscInternal.h).
    return [
      {
        start,
        end,
        direction: -points[first - 1]!.direction,
        ZG: p(1)[start]!,
        ZD: p(2)[start]!,
        GG: Math.max(...members.map((point) => point.price)),
        DD: Math.min(...members.map((point) => point.price)),
      },
    ];
  });
  return { points, centers };
}
