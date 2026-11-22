const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function isResearchDate(value: string) {
  return (
    datePattern.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** Research windows are bounded by actual data coverage, not a fixed year. */
export function assertResearchWindow(
  start: string,
  end: string,
  coverage?: { start?: string | null; end?: string | null },
) {
  for (const value of [start, end])
    if (!isResearchDate(value)) throw new Error(`研究窗口日期非法：${value}`);
  if (start > end) throw new Error("研究窗口开始晚于结束");
  if (coverage?.start && start < coverage.start)
    throw new Error(`研究窗口早于数据覆盖：${coverage.start}`);
  if (coverage?.end && end > coverage.end)
    throw new Error(`研究窗口晚于数据覆盖：${coverage.end}`);
}
