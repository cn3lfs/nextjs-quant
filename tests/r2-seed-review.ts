// Synthetic review records only. Never point this at a user database.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
const directory = resolve(".test-data/r2/browser");
assert.equal(resolve(process.env.QUANT_DATA_DIR ?? ""), directory);
const db = new Database(resolve(directory, "quant.sqlite"), {
  fileMustExist: true,
});
try {
  if (process.argv[2] === "market") {
    const root = resolve(".test-data/r2/tdx");
    const bars = Array.from({ length: 420 }, (_, index) => {
      const date = new Date(Date.UTC(2024, 0, index + 1))
        .toISOString()
        .slice(0, 10);
      const price = 100 + index * 0.05 + Math.sin(index / 8) * 4;
      return {
        date,
        open: price,
        high: price + 2,
        low: price - 2,
        close: price + Math.sin(index),
        volume: 100000 + index * 100,
        amount: 10000000,
      };
    });
    const binary = Buffer.alloc(bars.length * 32);
    bars.forEach((bar, index) => {
      const offset = index * 32;
      binary.writeUInt32LE(Number(bar.date.replaceAll("-", "")), offset);
      (["open", "high", "low", "close"] as const).forEach((key, n) =>
        binary.writeUInt32LE(Math.round(bar[key] * 100), offset + 4 + n * 4),
      );
      binary.writeFloatLE(bar.amount, offset + 20);
      binary.writeUInt32LE(bar.volume, offset + 24);
    });
    mkdirSync(resolve(root, "vipdoc/sh/lday"), { recursive: true });
    writeFileSync(resolve(root, "vipdoc/sh/lday/sh600519.day"), binary);
    writeFileSync(resolve(root, "vipdoc/sh/lday/sh000001.day"), binary);
    const stored = db
      .prepare("SELECT payload FROM records WHERE id='settings'")
      .get() as { payload: string };
    const settings = {
      ...JSON.parse(stored.payload),
      tdxRoot: root,
      calendar: bars.map((bar) => bar.date),
      autoAnalysis: false,
      autoNewsAnalysis: false,
    };
    db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
      JSON.stringify(settings),
    );
    console.log(
      "Synthetic OHLC fixtures written only inside .test-data/r2/tdx; no source directory modified",
    );
  }
  if (process.argv[2] === "screen") {
    const now = Date.UTC(2026, 8, 10, 2);
    const putJob = (id: string, type: string, result: unknown) => {
      const job = {
        id,
        type,
        status: "completed",
        progress: 100,
        createdAt: now,
        updatedAt: now,
        input: {},
        result,
      };
      db.prepare(
        "INSERT OR REPLACE INTO records (id,kind,payload,updated_at) VALUES (?,'job',?,?)",
      ).run(id, JSON.stringify(job), now);
    };
    putJob("r2-screen", "screen", {
      candidates: Array.from({ length: 123 }, (_, i) => ({
        symbol: `sh${600000 + i}`,
        name: `R2合成${i}`,
        snapshotId: `r2-snapshot-${i}`,
        metrics: {
          date: "2026-09-09",
          close: 10 + i,
          change: i,
          volumeRatio: 123 - i,
          score: i,
        },
      })),
      excluded: Array.from({ length: 53 }, (_, i) => ({
        symbol: `sz${String(i + 1).padStart(6, "0")}`,
        date: "2026-09-08",
        name: `R2隔离${i}`,
        reason: "R2合成隔离原因",
      })),
      errors: [],
      total: 176,
      asOf: "2026-09-09",
      elapsedMs: 1000,
      period: "day",
      researchMode: "latest-local",
      researchWarnings: [],
      universeSource: "R2合成夹具",
    });
    putJob("r2-online-screen", "online-screen", {
      query: "R2合成在线筛选结果，未请求远程服务",
      summary: "只用于表格迁移验证",
      fetchedAt: now,
      sourceDates: ["2026-09-09"],
      warnings: [],
      page: 1,
      pageSize: 2,
      total: 2,
      columns: [{ key: "change", label: "合成涨幅" }],
      rows: [
        {
          index: 0,
          symbol: "sh600519",
          name: "R2合成茅台",
          values: { change: 2 },
        },
        {
          index: 1,
          symbol: "sz000001",
          name: "R2合成平安",
          values: { change: -1 },
        },
      ],
      localCoverage: [],
      payloadHash: "r2-synthetic",
      schema: {},
    });
    console.log("R2 completed screening fixtures seeded; no jobs executed");
  }
  const signal = {
    id: "r2-synthetic-signal",
    strategy: "dual-breakout",
    symbol: "sh600519",
    observedDate: "2026-09-09",
    endpointDate: "2026-09-09",
    direction: "long",
    quality: "4/5",
    score: 4,
    evidence: "R2 合成截图夹具，非真实信号",
    invalidation: "R2 合成失效条件",
    snapshotHash: "r2-synthetic",
    strategyVersion: "r2-fixture",
    dllVersion: null,
    source: "tdx-local",
  };
  db.prepare("INSERT OR IGNORE INTO signal_ledger VALUES (?,?,?,?)").run(
    signal.id,
    signal.symbol,
    signal.observedDate,
    JSON.stringify(signal),
  );
  const run = {
    date: "2026-09-09",
    status: "complete",
    total: 1,
    scanned: 1,
    signals: 1,
    elapsedMs: 1000,
    errors: [],
    calendarSource: "R2 合成截图夹具",
    actionCoverageEnd: null,
    phase: "完成",
  };
  db.prepare("INSERT OR REPLACE INTO signal_ledger_runs VALUES (?,?)").run(
    run.date,
    JSON.stringify(run),
  );
  console.log(
    "R2 synthetic signal and completed run seeded; no notification records created",
  );
} finally {
  db.close();
}
