import { get } from "./db";
import type { Report } from "~/lib/domain";
import { fullRsSnapshot } from "./hithink-rs";
import { priceRsSnapshot } from "./price-rs";
export function exportRsArchive(reportId: string, evidenceId: string) {
  const report = get<Report>(reportId),
    evidence = report?.evidence.find((e) => e.id === evidenceId);
  const prices =
    evidence?.envelope?.source === "hithink-astock-selector/price-rs";
  if (
    !evidence ||
    (!prices && evidence.envelope?.source !== "hithink-astock-selector/rs")
  )
    throw new Error("报告中没有对应RS来源证据");
  let payload: { snapshotId?: string; snapshotHash?: string };
  try {
    payload = JSON.parse(evidence.text);
  } catch {
    throw new Error("RS证据格式不支持");
  }
  if (
    typeof payload.snapshotId !== "string" ||
    !(prices ? /^rs-prices-[a-f0-9]{64}$/ : /^rs-universe-[a-f0-9]{64}$/).test(
      payload.snapshotId,
    )
  )
    throw new Error("该旧证据未保存完整来源快照");
  const archive = get<{
    source: unknown;
    hash: string;
    capturedAt?: number;
    start?: string;
    end?: string;
  }>(payload.snapshotId);
  if (!archive) throw new Error("RS来源快照已缺失");
  const checked = prices
    ? priceRsSnapshot(archive.source, archive.start ?? "", archive.end ?? "")
    : fullRsSnapshot(archive.source);
  if (
    checked.id !== payload.snapshotId ||
    checked.hash !== payload.snapshotHash ||
    checked.hash !== archive.hash
  )
    throw new Error("RS来源快照指纹不一致，拒绝导出");
  const capturedAt =
    typeof archive.capturedAt === "number" &&
    Number.isFinite(archive.capturedAt) &&
    archive.capturedAt >= 0
      ? archive.capturedAt
      : null;
  return {
    format: "quant-rs-source-export-1",
    reportId,
    evidenceId,
    capturedAt,
    ...checked,
    warnings: [
      prices
        ? "来源返回价格列表及排除记录；有效价格池排名不等于完整全市场排名或历史池认证。"
        : "来源服务声明的完整A股涨幅列表；不等于独立交易所名单认证或历史时点已可用证明。",
      ...(!capturedAt
        ? ["旧快照未记录采集时间，不能作为当时已知的证券池档案。"]
        : []),
    ],
  };
}
