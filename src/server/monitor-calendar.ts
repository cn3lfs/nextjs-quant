import { createHash } from "node:crypto";
import { gfCalendarReference } from "./gf-calendar";
import { localCalendarReference, type CalendarReference } from "./data-health";
import { mcpProvider } from "./market-data";
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
      const days = (await mcpProvider.history("sh000001", "day")).bars
        .filter((b) => b.volume > 0)
        .map((b) => b.date);
      return {
        days,
        source: "通达信 MCP 上证指数已有日期（非完整交易日历）",
        hash: createHash("sha256").update(JSON.stringify(days)).digest("hex"),
      };
    } catch {
      /* Keep the local fallback explicit. */
    }
  }
  const local = await localCalendarReference(root, []);
  return {
    ...local,
    source: local.source + (shsz ? "；广发日历不可用" : "；未使用沪深专用日历"),
  };
}
