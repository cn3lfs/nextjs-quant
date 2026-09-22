/** Synthetic UI sample, never a real SH600000 signal or RPS measurement. */
import { resolve } from "node:path";
import { sqlite, put } from "../src/server/db";
import { IntradayStore } from "../src/server/monitoring/intraday-store";
import { evaluateIntraday } from "../src/server/monitoring/intraday-strategy";
import { analyzeCzsc, closeCzsc } from "../src/server/strategies/chan/czsc";
import { intradayConfigSchema } from "../src/lib/intraday-schedule";
import valid from "./fixtures/breakout-valid.json";

if (
  resolve(process.env.QUANT_DATA_DIR ?? "") !== resolve(".test-data/e1-browser")
)
  throw new Error(
    "Only the isolated E1/E2 browser fixture directory is supported",
  );
const config = intradayConfigSchema.parse({});
put("intraday-config", "intraday-config", config);
const store = new IntradayStore(sqlite());
try {
  const barCutoff = "2025-03-07T14:40:00+08:00";
  const value = await evaluateIntraday(
    {
      symbol: "sh600000",
      source: "tdx-local",
      observedAt: Date.parse(barCutoff) + 1000,
      barCutoff,
      bars: valid.bars,
      config: 0,
    },
    (bars) => analyzeCzsc(bars, true),
  );
  const preview = store.record({
    ...value,
    sessionId: "intraday-run:browser-sample",
    rpsDate: "2025-03-06",
    rps: 95,
    poolHash: "synthetic-browser-sample",
  });
  put("intraday-run", "intraday-run:browser-sample", {
    id: "intraday-run:browser-sample",
    date: "2025-03-07",
    slot: "late",
    config,
    status: "complete",
    startedAt: value.observedAt,
    updatedAt: value.observedAt,
    owner: "browser-fixture",
    leaseUntil: 0,
    previousTradingDay: "2025-03-06",
    calendarSource: "合成页面样本",
    pool: null,
    results: [{ symbol: "sh600000", observationId: preview.id, reason: null }],
    error: null,
  });
  store.confirm(preview.id, {
    observedAt: Date.parse("2025-03-07T15:10:00+08:00"),
    snapshotHash: value.snapshotHash,
    snapshot: value.snapshot,
    signalKeys: value.signals.map((signal) => signal.key),
    reason: null,
  });
  console.log("Synthetic preview fixture ready", preview.id);
} finally {
  await closeCzsc();
  sqlite().close();
}
