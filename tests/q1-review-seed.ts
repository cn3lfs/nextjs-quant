// Q1 browser review uses live local data and an isolated application DB only.
import { resolve } from "node:path";
const isolated = resolve(".test-data/q1/browser");
if (
  !process.env.QUANT_DATA_DIR ||
  resolve(process.env.QUANT_DATA_DIR) !== isolated
)
  throw new Error("Set QUANT_DATA_DIR to .test-data/q1/browser");
const { saveSettings } = await import("../src/server/infra/settings");
const { settingsSchema } = await import("../src/lib/domain");
saveSettings(
  settingsSchema.parse({ autoAnalysis: false, autoNewsAnalysis: false }),
);
console.log(
  "Q1 isolated settings ready; no notifications/subscriptions or mock trading enabled",
);

const { sqlite } = await import("../src/server/db");
const { ChartViewStore } =
  await import("../src/server/charts/chart-view-store");
const { defaultChartView, chartPeriodSchema } =
  await import("../src/lib/chart/chart-view");
for (const period of chartPeriodSchema.options)
  new ChartViewStore(sqlite()).save({
    symbol: "sh600519",
    period,
    view: defaultChartView,
  });
