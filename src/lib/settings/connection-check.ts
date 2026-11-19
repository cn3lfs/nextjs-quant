import { z } from "zod";
import { periodSchema, type Settings } from "~/lib/domain";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import {
  concreteMarketSources,
  marketSourceSchema,
} from "~/lib/market/market-source";

export const connectionCheckSchema = z.object({
  source: z.enum(concreteMarketSources),
  symbol: symbolSchema,
  period: periodSchema,
  configuration: z.object({
    tdxRoot: z.string(),
    calendar: z.array(z.string()),
    marketDataSource: marketSourceSchema,
  }),
  thsdkState: z
    .object({
      configRevision: z.string(),
      authGeneration: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ConnectionCheckInput = z.infer<typeof connectionCheckSchema>;
export type ConnectionCheckReasonCode =
  | "disabled"
  | "not_configured"
  | "auth_required"
  | "session_expired"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "empty"
  | "invalid"
  | "unsupported"
  | "unavailable";

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
  reasonCode?: ConnectionCheckReasonCode;
  thsdkState?: ConnectionCheckInput["thsdkState"];
};
