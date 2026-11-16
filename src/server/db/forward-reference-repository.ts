import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  strategyObjectSchema,
  type StrategyObjectInput,
} from "trading-strategies";
import type { PortfolioRequest } from "quant-backtest";
import type { ForwardDistribution } from "quant-performance";
import { executionCostsSchema } from "trading-strategy-core/costs";
import { marketRules } from "trading-strategy-core/market-rules";
import { sqlite } from "./index";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key: string, item: unknown) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            )
          : item,
      ),
    )
    .digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
  );
const referenceSchema = z
  .object({
    identity: z
      .object({
        strategyId: z.string().min(1),
        version: z.number().int().positive(),
        definitionHash: digest,
        inputHash: digest,
        buildHash: digest,
      })
      .strict(),
    frozenAt: z.number().finite().nonnegative(),
    days: z
      .array(
        z
          .object({
            date: day,
            return: z.number().finite().min(-1),
            signals: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1),
    tradeReturns: z.array(z.number().finite()),
    slippageBps: z.array(z.number().finite()),
    method: z.literal("lifecycle-2"),
    purpose: z.enum(["preregistered", "post-hoc"]),
    resultHash: digest,
    initial: z.number().finite().positive(),
    sizingPolicyHash: digest,
    backtestPassed: z.boolean(),
    slippageBasis: z.enum(["paper-model", "venue"]),
    source: z.string().min(1),
  })
  .strict();
export type FrozenForwardReference = z.infer<typeof referenceSchema> & {
  contentHash: string;
};
export type FreezeForwardReference = {
  strategy: StrategyObjectInput;
  distribution: Omit<ForwardDistribution, "identity" | "frozenAt">;
  inputHash: string;
  resultHash: string;
  buildHash: string;
  initial: number;
  sizingPolicyHash: string;
  backtestPassed: boolean;
  method: "lifecycle-2";
  purpose: "preregistered" | "post-hoc";
  slippageBasis: "paper-model" | "venue";
  source: string;
};
export const forwardDefinitionHash = (strategy: StrategyObjectInput) =>
  hash(strategyObjectSchema.parse(strategy));
/** All execution sizing assumptions are fixed alongside the return distribution. */
export function forwardSizingPolicyHash(
  request: Pick<
    PortfolioRequest,
    "market" | "initial" | "sleeves" | "costs" | "strategies"
  >,
) {
  return hash({
    market: request.market,
    initial: request.initial,
    sleeves: [...request.sleeves].sort((a, b) => a.id.localeCompare(b.id)),
    costs: executionCostsSchema.parse(
      request.costs ?? marketRules[request.market].costs,
    ),
    strategies: request.strategies
      .map((strategy) => ({
        id: strategy.id,
        version: strategy.version,
        sizing: strategyObjectSchema.parse(strategy).sizing,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/** Immutable distribution records and registration bindings use the existing
 * records table. Publication time is the local clock, never a supplied date. */
export class ForwardReferenceRepository {
  constructor(readonly db: Database.Database = sqlite()) {}
  private record<T>(id: string): T | null {
    const row = this.db
      .prepare("SELECT payload FROM records WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : null;
  }
  private immutable(kind: string, id: string, value: unknown) {
    const payload = JSON.stringify(value);
    const previous = this.db
      .prepare("SELECT payload FROM records WHERE id=?")
      .get(id) as { payload: string } | undefined;
    if (previous && previous.payload !== payload)
      throw new Error("Frozen forward evidence conflict");
    this.db
      .prepare("INSERT OR IGNORE INTO records VALUES(?,?,?,?)")
      .run(id, kind, payload, Date.now());
  }
  freeze(input: FreezeForwardReference): FrozenForwardReference {
    const strategy = strategyObjectSchema.parse(input.strategy);
    if (input.purpose === "post-hoc" && input.backtestPassed)
      throw new Error("Post-hoc evidence cannot pass a promotion gate");
    const value = referenceSchema.parse({
      ...input.distribution,
      identity: {
        strategyId: strategy.id,
        version: strategy.version,
        definitionHash: forwardDefinitionHash(strategy),
        inputHash: input.inputHash,
        buildHash: input.buildHash,
      },
      frozenAt: Date.now(),
      method: input.method,
      purpose: input.purpose,
      resultHash: input.resultHash,
      initial: input.initial,
      sizingPolicyHash: input.sizingPolicyHash,
      backtestPassed: input.backtestPassed,
      slippageBasis: input.slippageBasis,
      source: input.source,
    });
    if (
      value.days.some(
        (point, i) => i > 0 && point.date <= value.days[i - 1]!.date,
      )
    )
      throw new Error("Forward OOS dates must be strictly increasing");
    const completedAt =
      strategy.market === "crypto"
        ? Date.parse(`${value.days.at(-1)!.date}T00:00:00Z`) + 86400000
        : Date.parse(`${value.days.at(-1)!.date}T15:00:00+08:00`);
    if (completedAt > value.frozenAt)
      throw new Error("Cannot freeze an unfinished OOS day");
    const contentHash = hash(value);
    const result = { ...value, contentHash };
    this.db
      .transaction(() => {
        this.immutable(
          "forward-reference",
          `forward-reference:${contentHash}`,
          value,
        );
        this.db
          .prepare(
            "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
          )
          .run(
            `forward-reference-head:${strategy.id}:${strategy.version}`,
            "forward-reference-head",
            JSON.stringify({
              contentHash,
              definitionHash: value.identity.definitionHash,
            }),
            Date.now(),
          );
      })
      .immediate();
    return result;
  }
  read(contentHash: string): FrozenForwardReference | null {
    digest.parse(contentHash);
    const value = this.record<unknown>(`forward-reference:${contentHash}`);
    if (!value) return null;
    const parsed = referenceSchema.parse(value);
    if (hash(parsed) !== contentHash)
      throw new Error("Frozen forward distribution hash mismatch");
    return { ...parsed, contentHash };
  }
  bindPaper(
    accountId: string,
    strategy: StrategyObjectInput,
    startedAt: number,
  ) {
    const id = `paper-forward-reference:${accountId}:${strategy.id}:${strategy.version}`;
    const existing = this.record<{
      contentHash: string | null;
      definitionHash: string;
      startedAt: number;
    }>(id);
    if (existing) return existing;
    const definitionHash = forwardDefinitionHash(strategy);
    const head = this.record<{ contentHash: string; definitionHash: string }>(
      `forward-reference-head:${strategy.id}:${strategy.version}`,
    );
    const reference =
      head && head.definitionHash === definitionHash
        ? this.read(head.contentHash)
        : null;
    const binding = {
      contentHash:
        reference && reference.frozenAt <= startedAt
          ? reference.contentHash
          : null,
      definitionHash,
      startedAt,
    };
    this.immutable("paper-forward-reference", id, binding);
    return binding;
  }
  paper(accountId: string, strategy: StrategyObjectInput, startedAt: number) {
    const binding = this.record<{
      contentHash: string | null;
      definitionHash: string;
      startedAt: number;
    }>(
      `paper-forward-reference:${accountId}:${strategy.id}:${strategy.version}`,
    );
    if (
      !binding?.contentHash ||
      binding.startedAt !== startedAt ||
      binding.definitionHash !== forwardDefinitionHash(strategy)
    )
      return null;
    const reference = this.read(binding.contentHash);
    return reference && reference.frozenAt <= startedAt ? reference : null;
  }
}
