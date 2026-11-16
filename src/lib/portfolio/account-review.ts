import { z } from "zod";
import {
  accountTradeFingerprint,
  type AccountTrade,
} from "./account-workspace";

export const planJournalSchema = z.object({
  rationale: z.string().trim().max(1000).default(""),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).default([]),
});
export const tradeJournalSchema = z.object({
  tradeId: z.string().min(1).max(500),
  fingerprint: z.string().min(1).max(4000),
  factVersion: z.string().min(1).max(100),
  exitReason: z
    .enum(["stop", "target", "time", "rule", "manual", "unknown"])
    .default("unknown"),
  note: z.string().trim().max(1000).default(""),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).default([]),
});
export type TradeJournal = Omit<
  z.infer<typeof tradeJournalSchema>,
  "factVersion"
> & { updatedAt: number };
export const reviewTradeFingerprint = (trade: AccountTrade) =>
  JSON.stringify([
    accountTradeFingerprint(trade),
    trade.time,
    trade.timePrecision,
    trade.sourceOrder,
  ]);
export const batchTradeLinksSchema = z
  .object({
    confirmed: z.literal(true),
    factVersion: z.string().min(1).max(100),
    links: z
      .array(
        z
          .object({
            tradeId: z.string().min(1).max(500),
            fingerprint: z.string().min(1).max(4000),
            planId: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.links.map((l) => l.tradeId)).size !== v.links.length)
      c.addIssue({ code: "custom", message: "同一成交不能在同批关联两次" });
  });
