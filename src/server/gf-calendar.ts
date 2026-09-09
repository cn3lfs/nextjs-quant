import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { get, put } from "./db";
import type { CalendarReference } from "./data-health";
import { sharedRead } from "./shared-read";
const sharedCalendar = sharedRead<CalendarReference>();
const date = z
  .number()
  .int()
  .transform((value, context) => {
    const raw = String(value),
      formatted = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
    if (
      !/^\d{8}$/.test(raw) ||
      !Number.isFinite(Date.parse(formatted)) ||
      new Date(formatted).toISOString().slice(0, 10) !== formatted
    ) {
      context.addIssue({ code: "custom", message: "日历日期非法" });
      return z.NEVER;
    }
    return formatted;
  });
const responseSchema = z.object({
  errCode: z.literal(0),
  data: z.array(
    z.object({
      normDay: date,
      preTrdDay: date,
      nxtTrdDay: date,
      latesTrdDay: date,
      isTrdDay: z.union([z.literal(0), z.literal(1)]),
    }),
  ),
});
export function parseGfCalendar(
  raw: unknown,
  month: string,
): CalendarReference {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("日历月份非法");
  const parsed = responseSchema.parse(raw),
    rows = parsed.data;
  const count = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
  ).getUTCDate();
  if (rows.length !== count) throw new Error("日历月份覆盖不完整");
  for (const [index, row] of rows.entries()) {
    if (
      row.normDay !== `${month}-${String(index + 1).padStart(2, "0")}` ||
      row.preTrdDay >= row.normDay ||
      row.nxtTrdDay <= row.normDay ||
      row.latesTrdDay !== (row.isTrdDay ? row.normDay : row.preTrdDay)
    )
      throw new Error("日历日期关系不一致");
    const previous = rows
      .slice(0, index)
      .filter((r) => r.isTrdDay)
      .at(-1);
    const next = rows.slice(index + 1).find((r) => r.isTrdDay);
    for (const linked of [row.preTrdDay, row.nxtTrdDay]) {
      if (
        linked.startsWith(month + "-") &&
        !rows.some((r) => r.normDay === linked && r.isTrdDay === 1)
      )
        throw new Error("日历引用了非交易日");
    }
    if (
      (previous && previous.normDay !== row.preTrdDay) ||
      (next && next.normDay !== row.nxtTrdDay)
    )
      throw new Error("日历交易日链不一致");
  }
  return {
    days: [
      ...new Set([
        rows[0]!.preTrdDay,
        ...rows.filter((r) => r.isTrdDay).map((r) => r.normDay),
      ]),
    ],
    closedDays: rows.filter((r) => !r.isTrdDay).map((r) => r.normDay),
    source: `广发 gf-lhb 逐日交易标志（沪深，${month}）`,
    hash: createHash("sha256").update(JSON.stringify(parsed)).digest("hex"),
  };
}
export async function gfCalendarReference(
  now: number,
  signal?: AbortSignal,
): Promise<CalendarReference> {
  const month = new Date(now + 8 * 3600000).toISOString().slice(0, 7);
  return sharedCalendar(
    month,
    (sharedSignal) => loadCalendar(now, sharedSignal),
    signal,
  );
}
async function loadCalendar(
  now: number,
  signal: AbortSignal,
): Promise<CalendarReference> {
  signal?.throwIfAborted();
  const month = new Date(now + 8 * 3600000).toISOString().slice(0, 7),
    id = `gf-calendar-1-${month}`;
  const cached = get<{ fetchedAt: number; raw: unknown }>(id);
  if (cached && now >= cached.fetchedAt && now - cached.fetchedAt < 86400000)
    return parseGfCalendar(cached.raw, month);
  const document = parse(
    await readFile(join(homedir(), ".codex", "config.toml"), "utf8"),
  ) as unknown as { mcp_servers?: Record<string, { args?: string[] }> };
  const args = document.mcp_servers?.["gf-lhb"]?.args ?? [];
  const url = new URL(args[args.indexOf("--url") + 1] ?? "");
  if (url.href !== "https://mcp-api.gf.com.cn/server/mcp/lhb/mcp")
    throw new Error("未配置已支持的广发日历服务");
  const headers: Record<string, string> = {};
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--header") {
      const header = args[i + 1] ?? "",
        colon = header.indexOf(":");
      if (colon > 0 && header.slice(0, colon).toLowerCase() === "authorization")
        headers.Authorization = header.slice(colon + 1).trim();
    }
  const client = new Client({ name: "quant-calendar", version: "1.0.0" });
  const abort = () => {
    void client.close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
      { timeout: 15000 },
    );
    signal?.throwIfAborted();
    const result = await client.callTool(
      {
        name: "lhb_calendar_market_month_get",
        arguments: { market: "sh", month: Number(month.replace("-", "")) },
      },
      undefined,
      { timeout: 15000, signal },
    );
    if (result.isError) throw new Error("日历来源查询失败");
    const blocks = result.content as Array<{ type: string; text?: string }>;
    const text = blocks.filter((block) => block.type === "text");
    if (text.length !== 1 || !text[0]!.text)
      throw new Error("日历来源结构异常");
    const raw: unknown = JSON.parse(text[0]!.text),
      reference = parseGfCalendar(raw, month);
    signal?.throwIfAborted();
    put("calendar", id, { fetchedAt: now, raw });
    return reference;
  } catch {
    signal?.throwIfAborted();
    throw new Error("广发交易日历不可用");
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.close().catch(() => {});
  }
}
