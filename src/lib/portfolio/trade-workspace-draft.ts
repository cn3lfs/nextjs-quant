import { z } from "zod";
import { tradeInputSchema, type TradeInput } from "./trade-ledger";

export const tradeDraftFieldsSchema = z.object({
  symbol: z.string().max(20),
  date: z.string().max(10),
  side: z.enum(["buy", "sell"]),
  price: z.string().max(40),
  quantity: z.string().max(40),
  lowerLimit: z.string().max(40),
  upperLimit: z.string().max(40),
  limitSource: z.string().max(200),
  signalId: z.string().max(128),
  stop: z.string().max(40),
  note: z.string().max(500),
});
const draftSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  fields: tradeDraftFieldsSchema,
  submitted: z.boolean(),
  saved: z.boolean(),
  dirty: z.boolean(),
});
export type TradeDraft = z.infer<typeof draftSchema>;
export type TradeDraftFields = z.infer<typeof tradeDraftFieldsSchema>;
export function newTradeDraft(
  date: string,
  id = crypto.randomUUID(),
): TradeDraft {
  return {
    id,
    revision: 0,
    submitted: false,
    saved: false,
    dirty: false,
    fields: {
      symbol: "",
      date,
      side: "buy",
      price: "",
      quantity: "100",
      lowerLimit: "",
      upperLimit: "",
      limitSource: "",
      signalId: "",
      stop: "",
      note: "",
    },
  };
}
export function editTradeDraft(
  draft: TradeDraft,
  patch: Partial<TradeDraftFields>,
  nextId = crypto.randomUUID(),
): TradeDraft {
  return {
    ...draft,
    id: draft.submitted ? nextId : draft.id,
    revision: draft.revision + 1,
    submitted: false,
    saved: false,
    dirty: true,
    fields: { ...draft.fields, ...patch },
  };
}
export function tradeDraftInput(draft: TradeDraft): TradeInput {
  const f = draft.fields;
  return tradeInputSchema.parse({
    id: draft.id,
    ...f,
    symbol: f.symbol.trim(),
    price: Number(f.price),
    quantity: Number(f.quantity),
    lowerLimit: Number(f.lowerLimit),
    upperLimit: Number(f.upperLimit),
    signalId: f.signalId || null,
    stop: f.stop.trim() ? Number(f.stop) : null,
  });
}
export function submittedTradeDraft(draft: TradeDraft): TradeDraft {
  tradeDraftInput(draft);
  return { ...draft, submitted: true };
}
export function savedTradeDraft(
  current: TradeDraft,
  submittedId: string,
): TradeDraft {
  return current.id === submittedId
    ? { ...current, submitted: true, saved: true, dirty: false }
    : current;
}
export const tradeAttemptSchema = z.object({
  input: tradeInputSchema,
  state: z.enum(["pending", "unknown", "failed", "saved"]),
  error: z.string().max(2000).optional(),
});
export type TradeAttempt = z.infer<typeof tradeAttemptSchema>;
export const tradeDraftSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    draft: draftSchema,
    attempt: tradeAttemptSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.draft.submitted && value.attempt?.input.id === value.draft.id) {
      try {
        if (
          JSON.stringify(tradeDraftInput(value.draft)) !==
          JSON.stringify(value.attempt.input)
        )
          ctx.addIssue({ code: "custom", message: "草稿与已提交快照不一致" });
      } catch {
        ctx.addIssue({ code: "custom", message: "已提交草稿无效" });
      }
    }
  })
  .transform((value) => ({
    ...value,
    attempt:
      value.attempt?.state === "pending"
        ? { ...value.attempt, state: "unknown" as const }
        : value.attempt,
  }));
