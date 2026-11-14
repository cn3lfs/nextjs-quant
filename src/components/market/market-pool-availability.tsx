import type { MarketPoolAvailability } from "~/lib/market/market-pool";

/** Whole-source conditions are independent of the current page or filter. */
export function MarketPoolAvailabilityNote({
  availability,
  period,
  showDailyIndex = false,
}: {
  availability: MarketPoolAvailability;
  period: number;
  showDailyIndex?: boolean;
}) {
  const notes = [
    availability.rps === "missing"
      ? "当前数据源尚未计算 RPS，排名与涨幅暂缺。请先计算 RPS。"
      : availability.rps === "period-missing"
        ? `当前批次未计算 RPS${period}，该周期排名与涨幅暂缺；需要包含此周期的新批次。`
        : null,
    showDailyIndex && availability.dailyIndex !== "ready"
      ? availability.dailyIndex === "not-scanned"
        ? "当前数据源尚未扫描日线；可到数据与连接扫描已保存目录。已有完整包缓存仍按证券标注。"
        : "当前扫描未发现日线文件；请核对已保存目录及本地文件。已有完整包缓存仍按证券标注。"
      : null,
  ].filter(Boolean);
  return notes.length ? (
    <div role="status" className="space-y-1 text-sm text-muted-foreground">
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  ) : null;
}
