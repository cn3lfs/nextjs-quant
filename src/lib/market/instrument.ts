import { z } from "zod";
import { isCryptoSymbol } from "./crypto";
import { isFuturesSymbol } from "./futures";

export const markets = ["cn-equity", "crypto", "futures"] as const;
export const marketSchema = z.enum(markets);
export type Market = (typeof markets)[number];
export const instrumentSchema = z
  .object({
    symbol: z.string().min(1).max(40),
    market: marketSchema,
  })
  .strict()
  .refine(({ symbol, market }) => {
    if (market === "crypto") return isCryptoSymbol(symbol);
    if (market === "futures") return isFuturesSymbol(symbol);
    return /^(sh|sz|bj)\d{6}$/.test(symbol);
  }, "标的与市场不匹配");
export type Instrument = z.infer<typeof instrumentSchema>;
export function instrumentFor(symbol: string): Instrument {
  return instrumentSchema.parse({
    symbol,
    market: isCryptoSymbol(symbol)
      ? "crypto"
      : isFuturesSymbol(symbol)
        ? "futures"
        : "cn-equity",
  });
}
