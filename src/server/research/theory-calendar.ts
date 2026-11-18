import { createHash } from "node:crypto";
import { gfCalendarReference } from "../data-sources/gf/gf-calendar";
import type { CalendarReference } from "../market/data-health";

/** Official monthly flags are required; absent index bars never prove a holiday. */
export async function loadTheoryCalendar(
  start: string,
  end: string,
  read = gfCalendarReference,
): Promise<CalendarReference> {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
    start > end
  )
    throw new Error("Invalid theory calendar window");
  const refs: CalendarReference[] = [];
  for (let month = start.slice(0, 7); month <= end.slice(0, 7);) {
    try {
      refs.push(await read(Date.parse(`${month}-15T12:00:00+08:00`)));
    } catch {
      throw new Error(
        `研究所需官方交易日历不可用：${month}；未将未知日期推断为休市`,
      );
    }
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    month = d.toISOString().slice(0, 7);
  }
  const days = [...new Set(refs.flatMap((r) => r.days))].sort(),
    closedDays = [...new Set(refs.flatMap((r) => r.closedDays ?? []))].sort();
  const open = new Set(days),
    closed = new Set(closedDays);
  if (refs.some((r) => !r.hash) || days.some((day) => closed.has(day)))
    throw new Error("研究交易日历身份缺失或开闭市冲突");
  for (
    let day = start;
    day <= end;
    day = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10)
  )
    if (!open.has(day) && !closed.has(day))
      throw new Error(`研究交易日历日期缺失：${day}`);
  return {
    days,
    closedDays,
    source: "广发逐月交易标志；研究窗口完整校验",
    hash: createHash("sha256")
      .update(JSON.stringify(refs.map((r) => r.hash)))
      .digest("hex"),
  };
}
