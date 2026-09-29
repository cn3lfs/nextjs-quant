import { z } from "zod";
import { periodSchema, symbolSchema, type Settings } from "~/lib/domain";
import { marketSourceSchema } from "~/lib/market/market-source";

export const connectionCheckSchema = z.object({
  source: z.enum(["local", "pytdx", "eastmoney", "tencent"]),
  symbol: symbolSchema,
  period: periodSchema,
  configuration: z.object({
    tdxRoot: z.string(),
    calendar: z.array(z.string()),
    marketDataSource: marketSourceSchema,
  }),
});
export type ConnectionCheckInput = z.infer<typeof connectionCheckSchema>;
export function connectionConfiguration(settings: Settings) {
  return {
    tdxRoot: settings.tdxRoot,
    calendar: settings.calendar,
    marketDataSource: settings.marketDataSource,
  };
}
export type ConnectionCheckResult = {
  source: ConnectionCheckInput["source"];
  symbol: string;
  period: ConnectionCheckInput["period"];
  configuration: ConnectionCheckInput["configuration"];
  checkedAt: number;
  elapsedMs: number;
  connection: "ok" | "error" | "unknown";
  data: "ok" | "empty" | "invalid" | "unavailable";
  freshness: "aligned" | "lagging" | "unknown";
  dataAsOf: string | null;
  referenceAsOf: string | null;
  referenceSource: string;
  sampleCount: number;
  message: string;
  nextAction: string;
};
