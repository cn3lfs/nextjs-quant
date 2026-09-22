import { createHash } from "node:crypto";
import { z } from "zod";
import { type Evidence, symbolSchema } from "~/lib/domain";
import {
  canslimFloat,
  floatResponseSchema,
} from "../../../lib/strategy-facts/canslim-float";
import { evidenceEnvelope } from "../../infra/evidence";
import { request } from "./hithink-context";
import { sharedRead } from "../../infra/shared-read";

export function floatEvidence(
  symbol: string,
  raw: unknown,
  asOf: string,
  query: string,
  fetchedAt: number,
): Evidence {
  const response = floatResponseSchema.parse(raw);
  const diagnostic = canslimFloat(symbol, response, asOf);
  const payload = { query, response, asOf, diagnostic };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-basicinfo-query/float",
    symbol,
    type: "quote-financial",
    asOf,
    publishedAt: null,
    fetchedAt,
    currency: "CNY",
    unit: Object.fromEntries(
      response.columns.filter((c) => c.unit).map((c) => [c.key, c.unit!]),
    ),
    adjustment: "not-applicable",
    reportPeriod: null,
    quality: "partial",
    warnings: diagnostic.warnings,
  });
  return {
    id: `float-${envelope.payloadHash}`,
    source: envelope.source,
    asOf,
    envelope,
    text: JSON.stringify(payload),
  };
}

export function floatFromEvidence(
  symbol: string,
  asOf: string,
  evidence: Evidence,
) {
  if (
    evidence.envelope?.symbol !== symbol ||
    evidence.envelope.source !== "hithink-basicinfo-query/float" ||
    evidence.envelope.asOf !== asOf ||
    createHash("sha256").update(evidence.text).digest("hex") !==
      evidence.envelope.payloadHash
  )
    throw new Error("流通市值证据身份、日期或指纹不匹配");
  const payload = z
    .object({ asOf: z.literal(asOf), response: z.unknown() })
    .parse(JSON.parse(evidence.text));
  return canslimFloat(symbol, payload.response, asOf);
}

const shared = sharedRead<Evidence>();
export function queryFloat(symbol: string, asOf: string, signal?: AbortSignal) {
  symbolSchema.parse(symbol);
  const time = Date.parse(asOf);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== asOf
  )
    throw new Error("流通市值基准日期非法");
  return shared(
    `${symbol}:${asOf}`,
    async (upstream) => {
      if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
      const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
      const query = `${code} ${asOf.replaceAll("-", "")} 流通市值`;
      const raw = await request("hithink-basicinfo-query", query, upstream);
      upstream.throwIfAborted();
      return floatEvidence(symbol, raw, asOf, query, Date.now());
    },
    signal,
  );
}
