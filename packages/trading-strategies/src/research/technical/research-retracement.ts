export const researchRetracementVersion = "research-retracement-1";
export function researchRetracementStop(
  entry: number,
  initialStop: number,
  high: number,
) {
  if (
    ![entry, initialStop, high].every(Number.isFinite) ||
    initialStop <= 0 ||
    entry <= initialStop ||
    high < entry
  )
    return null;
  const peakR = (high - entry) / (entry - initialStop);
  const giveback =
    peakR >= 7
      ? 0.05
      : peakR >= 4
        ? 0.2
        : peakR >= 3
          ? 0.25
          : peakR >= 2
            ? 0.3
            : null;
  return giveback === null
    ? null
    : { peakR, giveback, stop: entry + (high - entry) * (1 - giveback) };
}
