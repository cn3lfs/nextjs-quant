import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { list, sqlite } from "../../src/server/db/index";
import {
  defaultStrategy,
  type Backtest,
  type Snapshot,
} from "../../src/lib/domain";
import type { ResearchUsage } from "../../src/lib/research/workflow/research-usage";

it("bundled backtest worker records actual window and survives usage-only database failure", async () => {
  const source: Snapshot = {
    id: "usage-worker",
    symbol: "sh600000",
    period: "day",
    source: "fixture",
    adjustment: "none",
    createdAt: 0,
    hash: "fixture",
    bars: Array.from({ length: 100 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      open: 100 + i,
      close: 101 + i,
      high: 102 + i,
      low: 99 + i,
      volume: 1000,
      amount: 100000,
    })),
  };
  sqlite();
  async function run() {
    const worker = new Worker(resolve("runtime/worker.cjs"));
    try {
      return await new Promise<{ source: Snapshot; result: Backtest }>(
        (resolve, reject) => {
          worker.once("error", reject);
          worker.on(
            "message",
            (message: {
              result?: { source: Snapshot; result: Backtest };
              error?: string;
            }) => {
              if (message.error) reject(new Error(message.error));
              if (message.result) resolve(message.result);
            },
          );
          worker.postMessage({
            type: "backtest",
            snapshot: source,
            strategy: defaultStrategy,
            initial: 100000,
          });
        },
      );
    } finally {
      await worker.terminate();
    }
  }
  const expected = await run();
  expect(list<ResearchUsage>("research-usage", -1)).toMatchObject([
    {
      kind: "backtest",
      symbols: [source.symbol],
      candidateCount: 1,
      range: { start: source.bars[0]!.date, end: source.bars.at(-1)!.date },
    },
  ]);
  sqlite().exec(
    "CREATE TRIGGER reject_usage BEFORE INSERT ON records WHEN NEW.kind='research-usage' BEGIN SELECT RAISE(FAIL, 'usage rejected'); END",
  );
  try {
    const actual = await run();
    expect(actual).toEqual(expected);
    expect(list("research-usage", -1)).toHaveLength(1);
  } finally {
    sqlite().exec("DROP TRIGGER reject_usage");
  }
});
