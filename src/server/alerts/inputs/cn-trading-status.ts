import { createHash } from "node:crypto";
import { type SecurityTradingStatus } from "~/lib/market/security-trading-status";
import { recordRuntimeError } from "../../infra/runtime-errors";
import { verifySecurityTradingStatus } from "../../market/security-trading-status";

export async function readEntryTradingStatus(
  symbol: string,
  now: number,
): Promise<SecurityTradingStatus> {
  try {
    return await verifySecurityTradingStatus(symbol);
  } catch (failure) {
    recordRuntimeError("alert-engine", failure);
    const evidence = { row: {}, columns: [] };
    return {
      version: "security-trading-status-1",
      symbol,
      status: "unknown",
      asOf: null,
      fetchedAt: now,
      source: "同花顺问财核验不可用",
      reason: "交易状态未知，请核验",
      evidence,
      evidenceHash: createHash("sha256")
        .update(JSON.stringify(evidence))
        .digest("hex"),
    };
  }
}
