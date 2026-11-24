import { z } from "zod";
import type { TradeMarkFill } from "./chart-trade-marks";

export const tradeReviewSourceKinds = [
  "lab-diagnose",
  "alpha-backtest",
  "etf-rotation",
  "paper-account",
  "real-delivery",
] as const;

export type TradeReviewSourceKind = (typeof tradeReviewSourceKinds)[number];

export const tradeReviewRefSchema = z
  .object({
    source: z.enum(tradeReviewSourceKinds),
    refId: z.string().min(1).max(4096),
    symbol: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(sh|sz|bj)\d{6}$/),
    label: z.string().min(1).max(240),
    backHref: z
      .string()
      .max(4096)
      .regex(/^\/(?!\/)[^\\\u0000-\u0020\u007f]*$/),
    accountId: z.string().min(1).max(240).optional(),
    unitKey: z.string().min(1).max(240).optional(),
  })
  .strict();

export type TradeReviewRef = z.infer<typeof tradeReviewRefSchema>;

export type TradeReviewFill = TradeMarkFill & {
  tradeId: string;
  backHref: string;
  price: number;
  quantity: number;
};

export type TradeReviewBox = {
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  pnlAmount: number | null;
  /** Percentages are percentage points. */
  pnlPct: number | null;
  maePct: number | null;
  maeDate: string | null;
  maePrice: number | null;
  mfePct: number | null;
  mfeDate: string | null;
  mfePrice: number | null;
  holdingDays: number | null;
  excursionReason: string | null;
  pnlReason: string | null;
  backHref: string;
  tradeIds: string[];
};

export type ChartTradeReview = {
  ref: TradeReviewRef;
  adjustment: "none";
  fills: TradeReviewFill[];
  boxes: TradeReviewBox[];
  warnings: string[];
};
