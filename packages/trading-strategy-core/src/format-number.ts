/** Display only: unknown and non-finite observations never become zero. */
export function formatNumber(value: number | null | undefined, digits = 2) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("zh-CN", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        useGrouping: false,
      });
}
export const formatPercent = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : `${formatNumber(value, digits)}%`;
