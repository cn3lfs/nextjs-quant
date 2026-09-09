import { createHash } from "node:crypto";
import { z } from "zod";
import type { Snapshot } from "~/lib/domain";
import { readGbbq } from "./tdx-gbbq";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const n = Date.parse(v);
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === v;
  });
const number = z.number().finite().nonnegative();
export function validateActionRange(start: string, end: string) {
  date.parse(start);
  date.parse(end);
  if (start > end) throw new Error("公司行动区间倒序");
}
const eventSchema = z
  .object({
    date,
    category: z.number().int().min(1).max(14),
    name: z.string().min(1),
    dividend: number.optional(),
    rightsPrice: number.optional(),
    bonusRatio: number.optional(),
    rightsRatio: number.optional(),
    shrinkRatio: number.optional(),
    strikePrice: number.optional(),
    warrantShares: number.optional(),
    floatSharesBefore: number.optional(),
    totalSharesBefore: number.optional(),
    floatSharesAfter: number.optional(),
    totalSharesAfter: number.optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.category === 1 &&
      [v.dividend, v.rightsPrice, v.bonusRatio, v.rightsRatio].some(
        (n) => n === undefined,
      )
    )
      ctx.addIssue({ code: "custom", message: "除权分项缺失" });
  });
export type BacktestActions = {
  version: "backtest-actions-1";
  status: "partial" | "missing";
  symbol: string;
  start: string;
  end: string;
  source?: { file: string; modified: number; fetchedAt: number; hash: string };
  events: z.infer<typeof eventSchema>[];
  warnings: string[];
};
type ActionSource = Pick<Snapshot, "symbol" | "source"> & {
  bars: { date: string }[];
};
export function actionReview(
  source: ActionSource,
  input: unknown[],
  metadata: Omit<NonNullable<BacktestActions["source"]>, "hash">,
): BacktestActions {
  const start = source.bars[0]?.date.slice(0, 10),
    end = source.bars.at(-1)?.date.slice(0, 10);
  if (!start || !end || start > end)
    throw new Error("公司行动核验区间为空或非法");
  date.parse(start);
  date.parse(end);
  // Current file is an ex-post observation, not an announcement-time archive.
  const events = z
    .array(eventSchema)
    .max(10000)
    .parse(input)
    .filter((e) => e.date >= start && e.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date) || a.category - b.category);
  if (
    new Set(events.map((e) => `${e.date}:${e.category}`)).size !== events.length
  )
    throw new Error("同日同类公司行动重复，需核验后才能使用");
  if (
    ![metadata.modified, metadata.fetchedAt].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    throw new Error("公司行动来源时点非法");
  const hash = createHash("sha256")
    .update(
      JSON.stringify({ symbol: source.symbol, start, end, events, metadata }),
    )
    .digest("hex");
  return {
    version: "backtest-actions-1",
    status: "partial",
    symbol: source.symbol,
    start,
    end,
    source: { ...metadata, hash },
    events,
    warnings: [
      "本机gbbq当前文件的事后事件核验；哈希覆盖所选证券区间的规范化事件和来源元数据，不是原始文件哈希或当时已知公告证明。",
      "解析器会跳过无法识别的记录；区间未列事件不等于已证明无公司行动。",
      "事件尚未计入模拟现金、可卖股数或复权信号；缺少派息到账、税负、送股可卖与配股参与信息，不能将除权日当作全部到账日。",
    ],
  };
}
export async function readBacktestActions(
  source: ActionSource,
  root?: string,
): Promise<BacktestActions> {
  const missing = (): BacktestActions => ({
    version: "backtest-actions-1",
    status: "missing",
    symbol: source.symbol,
    start: source.bars[0]?.date.slice(0, 10) ?? "",
    end: source.bars.at(-1)?.date.slice(0, 10) ?? "",
    events: [],
    warnings: ["本地公司行动来源缺失或未通过校验，未将缺失解释为无除权事件。"],
  });
  if (source.source !== "tdx-local" || !root) return missing();
  try {
    const data = await readGbbq(root);
    return actionReview(source, data.events.get(source.symbol) ?? [], {
      file: data.path,
      modified: data.modified,
      fetchedAt: Date.now(),
    });
  } catch {
    return missing();
  }
}
