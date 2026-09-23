import type { Bar } from "../../domain";

/** Five-minute bars are end-labelled in Shanghai time. No lunch bars. */
export function previewSlots(cutoff: string): string[] {
  if (!/^\d{2}:\d{2}$/.test(cutoff)) throw new Error("截止时间格式无效");
  const minutes = Number(cutoff.slice(0, 2)) * 60 + Number(cutoff.slice(3));
  const slots: string[] = [];
  for (const [start, end] of [
    [575, 690],
    [785, 900],
  ]) {
    for (let minute = start!; minute <= end!; minute += 5) {
      if (minute <= minutes)
        slots.push(
          `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
        );
    }
  }
  if (!slots.includes(cutoff))
    throw new Error("截止时间须为交易时段内已结束的5分钟线");
  return slots;
}

function validBar(bar: Bar) {
  return (
    [bar.open, bar.high, bar.low, bar.close].every(
      (v) => Number.isFinite(v) && v > 0,
    ) &&
    bar.high >= Math.max(bar.open, bar.close, bar.low) &&
    bar.low <= Math.min(bar.open, bar.close) &&
    [bar.volume, bar.amount].every((v) => Number.isFinite(v) && v >= 0)
  );
}

/** Construct a provisional daily bar solely from the captured minute prefix.
 * Callers supply a verified previous trading day and keep source/adjustment
 * identical across both inputs. This does not establish calendar provenance.
 */
export function previewBars(input: {
  date: string;
  previousTradingDay: string;
  cutoff: string;
  observedAt: number;
  daily: readonly Bar[];
  minutes: readonly Bar[];
}): Bar[] {
  const { date, previousTradingDay, cutoff, observedAt } = input;
  const end = Date.parse(`${date}T${cutoff}:00+08:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(end) ||
    !Number.isFinite(observedAt) ||
    end > observedAt ||
    previousTradingDay >= date
  )
    throw new Error("预选时点或交易日无效");
  const slots = previewSlots(cutoff);
  const daily = input.daily.filter((bar) => bar.date < date);
  if (daily.length < 61 || daily.at(-1)?.date !== previousTradingDay)
    throw new Error("历史日线不足或未更新至上一交易日");
  if (
    daily.some(
      (bar, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
        !validBar(bar) ||
        (i > 0 && bar.date <= daily[i - 1]!.date),
    )
  )
    throw new Error("历史日线无效或顺序异常");
  const minuteBars = input.minutes.filter(
    (bar) =>
      bar.date.startsWith(`${date}T`) && bar.date.slice(11, 16) <= cutoff,
  );
  if (
    minuteBars.length !== slots.length ||
    minuteBars.some(
      (bar, i) => bar.date !== `${date}T${slots[i]}:00+08:00` || !validBar(bar),
    )
  )
    throw new Error("当日5分钟行情缺失、重复或时点不连续");
  const partial: Bar = {
    date,
    open: minuteBars[0]!.open,
    close: minuteBars.at(-1)!.close,
    high: Math.max(...minuteBars.map((bar) => bar.high)),
    low: Math.min(...minuteBars.map((bar) => bar.low)),
    volume: minuteBars.reduce((sum, bar) => sum + bar.volume, 0),
    amount: minuteBars.reduce((sum, bar) => sum + bar.amount, 0),
  };
  if (!validBar(partial)) throw new Error("当日聚合行情无效");
  return [...daily.map((bar) => ({ ...bar })), partial];
}

export function previewConfirmation(
  signalKey: string,
  closeKeys: readonly string[] | null,
) {
  // null denotes unavailable computation, never an absent signal.
  return closeKeys === null
    ? "unavailable"
    : closeKeys.includes(signalKey)
      ? "confirmed"
      : "withdrawn";
}
