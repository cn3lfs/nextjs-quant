import { archiveIntervals } from "../data-sources/binance/public-data";
import { readPublicData } from "../data-sources/binance/public-data-store";

export type BinanceArchiveAuditWork = {
  type: "binance-archive-audit";
  root: string;
};
export async function auditBinanceArchive(
  work: BinanceArchiveAuditWork,
  progress: (n: number, phase: string) => void = () => {},
) {
  const series = [];
  for (const symbol of ["BTCUSDT", "ETHUSDT"])
    for (const interval of archiveIntervals) {
      const { rows: _rows, ...result } = await readPublicData(
        symbol,
        interval,
        { root: work.root, includeRows: false },
      );
      series.push({ symbol, interval, ...result });
      progress(
        Math.round((series.length / (2 * archiveIntervals.length)) * 100),
        `校验 ${symbol} ${interval}`,
      );
    }
  return {
    root: work.root,
    checkedAt: Date.now(),
    series,
    boundary: "仅校验本地官方校验文件、CSV及覆盖；不下载，不补造缺口",
  };
}
