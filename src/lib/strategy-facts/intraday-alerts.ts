import { z } from "zod";
import { accountKinds } from "../portfolio/account-workspace";

const price = z.number().finite().positive();
export const intradayAlertConfigSchema = z.object({
  enabled: z.boolean(),
  pollIntervalSec: z.number().int().min(15).max(300),
  monitorHoldingsStops: z.boolean(),
  monitorPlannedEntries: z.boolean(),
  monitorWatchlistRules: z.boolean(),
  intradayScanEnabled: z.boolean(),
});
export const intradayWatchRuleInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  symbol: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(sh|sz|bj)\d{6}$/),
  direction: z.enum(["above", "below"]),
  thresholdPrice: price,
  enabled: z.boolean(),
  note: z.string(),
});
export const intradayWatchRuleSchema = intradayWatchRuleInputSchema.extend({
  id: z.string(),
  // Wave 0 stored the original user input, including noncanonical symbols.
  symbol: z.string(),
  lastTriggeredDate: z.string().date().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const triggerKind = z.enum([
  "stop_loss",
  "take_profit",
  "planned_entry",
  "watch_above",
  "watch_below",
]);
const event = z.object({
  alertKey: z.string(),
  eventKey: z.string(),
  symbol: z.string(),
  triggerKind,
  thresholdPrice: price,
  price: price,
  priceBasis: z.literal("intraday_quote"),
  source: z.string(),
  quoteAt: z.number(),
  observedAt: z.number(),
  mode: z.enum(["shadow", "live"]),
});
const holding = z.object({
  positionId: z.string(),
  account: z.string(),
  kind: z.enum(accountKinds),
  symbol: z.string(),
  stopPrice: price.nullable(),
  targetPrice: price.nullable(),
  price: price.nullable(),
  quoteAt: z.number().nullable(),
  quoteStatus: z.enum(["fresh", "stale", "missing"]),
  // Signed yuan per share. Negative means the respective level was crossed.
  distanceToStop: z.number().nullable(),
  distanceToTarget: z.number().nullable(),
});
export const intradayAlertStatusSchema = z.object({
  config: intradayAlertConfigSchema,
  rules: z.array(intradayWatchRuleSchema),
  session: z.enum(["trading", "lunch-break", "closed"]),
  lastCheckedAt: z.number().nullable(),
  lastQuoteSource: z.string().nullable(),
  lastResult: z
    .object({
      status: z.enum(["checked", "no-targets", "error"]),
      freshCount: z.number().int(),
      staleCount: z.number().int(),
      missingCount: z.number().int(),
      triggeredCount: z.number().int(),
    })
    .nullable(),
  monitoredSymbolCount: z.number().int(),
  recentEvents: z.array(event),
  holdings: z.array(holding),
});
export type IntradayAlertConfig = z.infer<typeof intradayAlertConfigSchema>;
export type IntradayWatchRuleInput = z.input<
  typeof intradayWatchRuleInputSchema
>;
export type IntradayWatchRule = z.infer<typeof intradayWatchRuleSchema>;
export type IntradayAlertStatus = z.infer<typeof intradayAlertStatusSchema>;
export type IntradayTriggerEvent = z.infer<typeof event>;
export type IntradayHoldingPreview = z.infer<typeof holding>;
