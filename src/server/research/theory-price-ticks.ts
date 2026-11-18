import { createHash } from "node:crypto";
import { z } from "zod";
import { outboundFetch } from "../infra/outbound";
export type TheoryPriceTick = {
  tick: number;
  source: string;
  observedAt: string;
  responseHash: string;
};
const url =
  "https://data-api.binance.vision/api/v3/exchangeInfo?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22%5D";
const responseSchema = z.object({
  symbols: z.array(
    z.object({
      symbol: z.enum(["BTCUSDT", "ETHUSDT"]),
      filters: z.array(
        z.object({ filterType: z.string(), tickSize: z.string().optional() }),
      ),
    }),
  ),
});
export function parseTheoryPriceTicks(
  raw: unknown,
  observedAt: string,
): Record<string, TheoryPriceTick> {
  if (!Number.isFinite(Date.parse(observedAt)))
    throw new Error("Invalid tick observation timestamp");
  const parsed = responseSchema.parse(raw),
    result: Record<string, TheoryPriceTick> = {};
  const responseHash = createHash("sha256")
    .update(JSON.stringify(raw))
    .digest("hex");
  for (const row of parsed.symbols) {
    const filters = row.filters.filter((f) => f.filterType === "PRICE_FILTER");
    const tick = Number(filters[0]?.tickSize);
    if (
      result[`cx${row.symbol}`] ||
      filters.length !== 1 ||
      !Number.isFinite(tick) ||
      tick <= 0
    )
      throw new Error("Missing or ambiguous official price increment");
    result[`cx${row.symbol}`] = { tick, source: url, observedAt, responseHash };
  }
  if (Object.keys(result).length !== 2)
    throw new Error("BTC/ETH price increment coverage incomplete");
  return result;
}
/** Public market metadata only; no authentication, orders or persisted account settings. */
export async function loadTheoryPriceTicks(
  fetcher = outboundFetch,
  now = Date.now(),
) {
  const { response } = await fetcher(url, { method: "GET" });
  if (!response.ok)
    throw new Error(
      `Official price increments unavailable (${response.status})`,
    );
  return parseTheoryPriceTicks(
    await response.json(),
    new Date(now).toISOString(),
  );
}
