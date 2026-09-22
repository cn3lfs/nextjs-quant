import { createHash } from "node:crypto";
import {
  evidenceEnvelopeSchema,
  type EvidenceEnvelope,
} from "~/lib/evidence-envelope";
import type { Evidence } from "~/lib/domain";

export function evidenceEnvelope(
  payload: unknown,
  metadata: Omit<EvidenceEnvelope, "version" | "payloadHash">,
): EvidenceEnvelope {
  return evidenceEnvelopeSchema.parse({
    ...metadata,
    version: "evidence-1",
    payloadHash: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  });
}

export function remoteResearchEvidence(
  symbol: string,
  tool: "tdx_quotes" | "wenda_notice_query",
  payload: unknown,
  fetchedAt: number,
): Evidence & { fetchedAt: number } {
  const raw = JSON.stringify(payload);
  const envelope = evidenceEnvelope(payload, {
    source: `tdx-mcp/${tool}`,
    symbol,
    type: tool === "tdx_quotes" ? "quote-financial" : "announcement",
    asOf: null,
    publishedAt: null,
    fetchedAt,
    currency: null,
    unit: {},
    adjustment: "unknown",
    reportPeriod: null,
    quality: "partial",
    warnings: [
      "抓取时间不等于资料时点；源日期、财报期、币种、单位及复权尚未逐字段核验。",
      "仅供当前研究，不得作为历史时点可用证据。",
      ...(raw.length > 14000
        ? ["提示词内容截取前 14000 字符；payloadHash 对应完整源响应。"]
        : []),
    ],
  });
  return {
    id: `evidence-${symbol}-${tool}-${envelope.payloadHash.slice(0, 16)}`,
    source: `通达信 MCP / ${tool}（当前研究资料，非历史时点）`,
    asOf: "源时点未核验",
    text: raw.slice(0, 14000),
    fetchedAt,
    envelope,
  };
}
