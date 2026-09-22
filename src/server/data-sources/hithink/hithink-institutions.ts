import { randomBytes } from "node:crypto";
import { z } from "zod";
import { symbolSchema, type Evidence } from "~/lib/domain";
import {
  canslimInstitutions,
  institutionResponseSchema,
} from "../../../lib/strategy-facts/canslim-institutions";
import { evidenceEnvelope } from "../../infra/evidence";
import { sharedRead } from "../../infra/shared-read";
export function institutionsEvidence(
  symbol: string,
  raw: unknown,
  query: string,
  fetchedAt: number,
): Evidence {
  const response = institutionResponseSchema.parse(raw);
  const diagnostic = canslimInstitutions(symbol, response);
  const payload = { query, response, diagnostic };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-management-query",
    symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt,
    currency: null,
    unit: Object.fromEntries(
      response.columns.filter((c) => c.unit).map((c) => [c.key, c.unit!]),
    ),
    adjustment: "not-applicable",
    reportPeriod: null,
    quality: "partial",
    warnings: diagnostic.warnings,
  });
  return {
    id: `institutions-${symbol}-${envelope.payloadHash}`,
    source: envelope.source,
    asOf: "当前抓取，披露时点未核验",
    envelope,
    text: JSON.stringify(payload),
  };
}
const shared = sharedRead<Evidence>();
export function queryInstitutions(symbol: string, signal?: AbortSignal) {
  symbolSchema.parse(symbol);
  return shared(
    symbol,
    async (upstream) => {
      const key = process.env.IWENCAI_API_KEY;
      if (!key) throw new Error("未配置问财凭证");
      const deadline = AbortSignal.any([upstream, AbortSignal.timeout(30000)]);
      const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
      const queries = [
        `${code} 最近3个季度 机构持股数量 机构持股比例 持股机构家数`,
        `${code} 最近三个季度 机构持股数量 机构持股占流通股比例 持股机构家数`,
        `${code} 最近4个季度 机构持股数量 机构持股占流通股比例 持股机构家数`,
      ];
      for (const [attempt, query] of queries.entries()) {
        deadline.throwIfAborted();
        const response = await fetch(
          "https://openapi.iwencai.com/v1/query2data",
          {
            method: "POST",
            signal: deadline,
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              "X-Claw-Call-Type": attempt ? "retry" : "normal",
              "X-Claw-Skill-Id": "hithink-management-query",
              "X-Claw-Skill-Version": "1.0.0",
              "X-Claw-Plugin-Id": "none",
              "X-Claw-Plugin-Version": "none",
              "X-Claw-Trace-Id": randomBytes(32).toString("hex"),
            },
            body: JSON.stringify({
              query,
              page: "1",
              limit: "10",
              is_cache: "1",
              expand_index: "true",
            }),
          },
        );
        if (!response.ok) throw new Error("机构持仓查询失败");
        const raw: unknown = await response.json();
        deadline.throwIfAborted();
        if (
          z
            .object({
              status_code: z.literal(0),
              datas: z.array(z.unknown()).length(0),
            })
            .safeParse(raw).success
        )
          continue;
        return institutionsEvidence(symbol, raw, query, Date.now());
      }
      throw new Error("机构持仓查询三次均无结果");
    },
    signal,
  );
}
