import type { Bar } from "~/lib/domain";
export function bottomShape(cup: Bar[], leftHigh: number, bottom: number) {
  let run = 0,
    longest = 0;
  for (const bar of cup) {
    run = bar.low <= bottom + (leftHigh - bottom) * 0.2 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const rounded = longest >= 10;
  const troughs: number[] = [];
  for (let index = 3; index <= cup.length - 4; index++) {
    const peers = cup
      .slice(index - 3, index + 4)
      .filter((_, offset) => offset !== 3);
    if (
      cup[index]!.low <= bottom + (leftHigh - bottom) * 0.2 &&
      peers.every((b) => cup[index]!.low < b.low) &&
      !peers.every((b) => cup[index]!.high > b.high)
    )
      troughs.push(index);
  }
  let doubleBottom: {
    first: string;
    second: string;
    firstConfirmedAt: string;
    secondConfirmedAt: string;
    recovery: number;
  } | null = null;
  for (let index = 1; index < troughs.length; index++) {
    const first = troughs[index - 1]!,
      second = troughs[index]!;
    const recovery = Math.max(
      ...cup.slice(first + 1, second).map((b) => b.high),
    );
    if (second - first >= 5 && recovery >= bottom + (leftHigh - bottom) * 0.3) {
      doubleBottom = {
        first: cup[first]!.date,
        second: cup[second]!.date,
        firstConfirmedAt: cup[first + 3]!.date,
        secondConfirmedAt: cup[second + 3]!.date,
        recovery,
      };
      break;
    }
  }
  const shape = rounded
    ? "U"
    : doubleBottom
      ? "W"
      : longest < 3
        ? "V"
        : "unclassified";
  return { longest, rounded, doubleBottom, shape };
}
