import { createHash } from "node:crypto";
import { gfCalendarReference } from "./gf-calendar";
import { localCalendarReference, type CalendarReference } from "./data-health";
import { preferredOnlineChart } from "./preferred-online-chart";
// g4day 暂停：import { readDailyIncrementRange } from "./tdx-daily-cache";
export async function monitorCalendar(
  root: string,
  overrides: string[],
  remote: boolean,
  shsz: boolean,
  now: number,
): Promise<CalendarReference> {
  if (overrides.length) return localCalendarReference(root, overrides);
  if (shsz) {
    try {
      return await gfCalendarReference(now);
    } catch {
      /* Fall back to observed dates. */
    }
  }
  if (remote) {
    try {
      const days = (await preferredOnlineChart("sh000001", "day")).bars
        .filter((b) => b.volume > 0)
        .map((b) => b.date);
      return {
        days,
        source: "免费在线源上证指数已有日期（非完整交易日历）",
        hash: createHash("sha256").update(JSON.stringify(days)).digest("hex"),
      };
    } catch {
      /* Keep the local fallback explicit. */
    }
  }
  const local = await localCalendarReference(root, []);
  // g4day 暂停（见 docs/decisions.md WF3）：日历只用本地观测日期，不再并入增量日期。
  // const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  // const start = local.days[0] ?? today;
  // const increments =
  //   shsz && start <= today
  //     ? readDailyIncrementRange("sh000001", start, today).filter(
  //         ({ snapshot, record }) =>
  //           snapshot.observedAt <= now && record.bar.volume > 0,
  //       )
  //     : [];
  // if (increments.length) {
  //   const days = [
  //     ...new Set([
  //       ...local.days,
  //       ...increments.map(({ record }) => record.bar.date),
  //     ]),
  //   ].sort();
  //   return {
  //     ...local,
  //     days,
  //     source:
  //       local.source +
  //       "；通达信日线增量已有日期（非完整交易日历）；广发日历不可用",
  //     hash: createHash("sha256")
  //       .update(
  //         JSON.stringify({
  //           base: local.hash,
  //           days,
  //           increments: increments.map(({ snapshot }) => snapshot.id),
  //         }),
  //       )
  //       .digest("hex"),
  //   };
  // }
  return {
    ...local,
    source: local.source + (shsz ? "；广发日历不可用" : "；未使用沪深专用日历"),
  };
}
