import type Database from "better-sqlite3";
import { z } from "zod";
import {
  strategyObjectSchema,
  type StrategyObjectInput,
} from "trading-strategies";
import type { WatchEvent } from "../strategies/drivers/watch";
import { alertKinds } from "~/lib/strategy-facts/alerts";
import { sqlite } from "./index";
import {
  planProtectionSchema,
  planSizingAuditSchema,
} from "~/lib/strategy-facts/plan-policy";
import { exposureCapSchema } from "~/lib/portfolio/account-workspace";

const positive = z.number().finite().positive();
export const watchEventSchema = z
  .object({
    key: z.string().min(1),
    strategyId: z.string().min(1),
    version: z.number().int().positive(),
    market: z.enum(["cn-equity", "crypto"]),
    symbol: z.string().min(1),
    bar: z.string().refine((v) => Number.isFinite(Date.parse(v))),
    type: z.enum(["entry", "exit", "stop", "target"]),
    price: positive,
    sleeve: z.string().min(1),
    stop: positive.nullable(),
    target: positive.nullable(),
    rankScore: z.number().finite().optional(),
    targetWeight: z.number().finite().min(0).max(1).optional(),
  })
  .strict();
const storedEventSchema = watchEventSchema
  .extend({ type: z.enum(alertKinds), price: positive.nullable() })
  .passthrough();
export const tradePlanSchema = z
  .object({
    id: z.string().min(1),
    strategyId: z.string().min(1),
    strategyVersion: z.number().int().positive(),
    symbol: z.string().min(1),
    sleeve: z.string().min(1),
    triggerKey: z.string().min(1),
    rationale: z.string().max(1000).optional(),
    tags: z.array(z.string().max(32)).max(12).optional(),
    entry: positive,
    tranches: z.number().int().min(1).max(100),
    quantity: positive.nullable(),
    stop: positive.nullable(),
    target: positive.nullable(),
    expiresAt: z
      .string()
      .refine((v) => Number.isFinite(Date.parse(v)))
      .nullable(),
    status: z.enum(["open", "closed", "expired"]),
    market: z.enum(["cn-equity", "crypto"]).optional(),
    stages: z
      .array(z.object({ entry: positive, quantity: positive }))
      .max(100)
      .optional(),
    closeReason: z.enum(["triggered", "cancelled", "expired"]).optional(),
    createdAt: z.number().finite().optional(),
    protection: planProtectionSchema.optional(),
    sizingAudit: planSizingAuditSchema.optional(),
    positionSnapshot: z
      .object({
        at: z.number().finite(),
        basis: z.enum(["intraday", "post-close"]),
        unassignedValue: z.number().finite().nonnegative(),
      })
      .optional(),
    exposureAudit: z
      .object({
        at: z.number(),
        overridden: z.boolean(),
        caps: z.array(exposureCapSchema),
        industryGroups: z
          .object({
            source: z
              .object({
                hash: z.string(),
                basis: z.literal("current-labelled"),
                grouping: z.literal("all-known-groups"),
              })
              .nullable(),
            proposed: z.object({
              market: z.enum(["cn-equity", "crypto"]),
              symbol: z.string(),
              groups: z.array(z.string()),
            }),
            reserved: z.array(
              z.object({
                market: z.enum(["cn-equity", "crypto"]),
                symbol: z.string(),
                groups: z.array(z.string()),
              }),
            ),
          })
          .optional(),
        violations: z.array(
          z.object({
            dimension: z.string(),
            key: z.string(),
            used: z.number().nullable(),
            limit: z.number(),
            reason: z.string(),
          }),
        ),
      })
      .optional(),
    quantityRules: z
      .object({ step: positive, minimum: positive, source: z.string().min(1) })
      .optional(),
  })
  .strict();
export type TradePlan = z.infer<typeof tradePlanSchema>;

/** Immutable definitions and deduped observations. No scheduling or delivery side effects.
 * Local records live until the owner explicitly deletes them; never evict trading evidence.
 */
export class StrategyRepository {
  constructor(private readonly connection: Database.Database = sqlite()) {}
  saveStrategy(raw: StrategyObjectInput) {
    const strategy = strategyObjectSchema.parse(raw);
    const payload = JSON.stringify(strategy);
    return this.connection
      .transaction(() => {
        const existing = this.connection
          .prepare("SELECT payload FROM strategies WHERE id=? AND version=?")
          .get(strategy.id, strategy.version) as
          { payload: string } | undefined;
        if (existing && existing.payload !== payload)
          throw new Error("Strategy version is immutable");
        if (!existing)
          this.connection
            .prepare("INSERT INTO strategies VALUES(?,?,?,?,?)")
            .run(
              strategy.id,
              strategy.version,
              strategy.market,
              payload,
              Date.now(),
            );
        return strategy;
      })
      .immediate();
  }
  strategy(id: string, version: number) {
    const row = this.connection
      .prepare("SELECT payload FROM strategies WHERE id=? AND version=?")
      .get(id, version) as { payload: string } | undefined;
    return row ? strategyObjectSchema.parse(JSON.parse(row.payload)) : null;
  }
  /** Event and optional plan commit together; replay never overwrites first-seen evidence. */
  record(
    raw: StrategyObjectInput,
    eventInput: WatchEvent,
    planInput?: TradePlan,
  ) {
    const event = watchEventSchema.parse(eventInput);
    const plan = planInput ? tradePlanSchema.parse(planInput) : undefined;
    return this.connection
      .transaction(() => {
        const strategy = this.saveStrategy(raw);
        if (
          event.strategyId !== strategy.id ||
          event.version !== strategy.version ||
          event.market !== strategy.market ||
          event.sleeve !== strategy.sleeve ||
          event.key !==
            JSON.stringify([
              strategy.id,
              strategy.version,
              strategy.market,
              event.symbol,
              event.bar,
            ])
        )
          throw new Error("Event strategy identity mismatch");
        if (
          plan &&
          (plan.triggerKey !== event.key ||
            plan.strategyId !== strategy.id ||
            plan.strategyVersion !== strategy.version ||
            plan.symbol !== event.symbol ||
            plan.sleeve !== strategy.sleeve)
        )
          throw new Error("Plan trigger mismatch");
        if (
          this.connection
            .prepare("SELECT 1 FROM watch_events WHERE dedupe_key=?")
            .get(event.key)
        )
          return false;
        if (plan)
          this.connection
            .prepare("INSERT INTO trade_plans VALUES(?,?,?,?,?,?,?,?,?,?)")
            .run(
              plan.id,
              plan.strategyId,
              plan.strategyVersion,
              plan.symbol,
              plan.sleeve,
              plan.triggerKey,
              plan.expiresAt,
              plan.status,
              JSON.stringify(plan),
              Date.now(),
            );
        this.connection
          .prepare("INSERT INTO watch_events VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(
            event.key,
            strategy.id,
            strategy.version,
            event.symbol,
            event.bar,
            event.type,
            event.price,
            plan ? "planned" : "new",
            plan?.id ?? null,
            JSON.stringify(event),
          );
        return true;
      })
      .immediate();
  }
  events(limit: number, after?: { bar: string; key: string }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error("Invalid event page size");
    const rows = this.connection
      .prepare(
        `SELECT bar,dedupe_key,payload FROM watch_events ${after ? "WHERE (bar,dedupe_key)>(?,?)" : ""} ORDER BY bar,dedupe_key LIMIT ?`,
      )
      .all(...(after ? [after.bar, after.key, limit + 1] : [limit + 1])) as {
      bar: string;
      dedupe_key: string;
      payload: string;
    }[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) =>
        storedEventSchema.parse(JSON.parse(row.payload)),
      ),
      next:
        rows.length > limit && last
          ? { bar: last.bar, key: last.dedupe_key }
          : null,
    };
  }
  plan(id: string) {
    const row = this.connection
      .prepare("SELECT payload FROM trade_plans WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? tradePlanSchema.parse(JSON.parse(row.payload)) : null;
  }
}
