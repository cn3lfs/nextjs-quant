import type { Period } from "~/lib/domain";
import { readSnapshot } from "./tdx";
import { readLocalDailySnapshot } from "./local-daily-snapshot";

/** 图表入口显式启用基金；研究扫描与原 readSnapshot 的证券门禁不变。 */
export function readVipdocChart(root: string, symbol: string, period: Period) {
  return period === "day"
    ? readLocalDailySnapshot(root, symbol, { chartFunds: true })
    : readSnapshot(root, symbol, period, { chartFunds: true });
}
