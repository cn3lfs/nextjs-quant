import { Worker } from "node:worker_threads";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import valid from "./fixtures/breakout-valid.json";
import { migrate } from "../src/server/db/migrations";
import { projectCzsc, closeCzsc } from "../src/server/strategies/chan/czsc";
import { ResearchStore } from "../src/server/backtest/research-store";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/backtest/research-dataset";

it("executes the bundled research worker and reproduces trades from an immutable snapshot", async () => {
  await mkdir(".test-data", { recursive: true });
  const directory = await mkdtemp(resolve(".test-data/research-worker-"));
  const db = new Database(join(directory, "quant.sqlite"));
  migrate(db);
  const workers: Worker[] = [];
  let projections = 0;
  try {
    const bars = structuredClone(valid.bars);
    const signalDate = bars.at(-1)!.date;
    let day = Date.parse(signalDate);
    for (let i = 0; i < 10; i++) {
      do {
        day += 86400000;
      } while ([0, 6].includes(new Date(day).getUTCDay()));
      const price = bars.at(-1)!.close;
      bars.push({
        ...bars.at(-1)!,
        date: new Date(day).toISOString().slice(0, 10),
        open: price,
        close: price + 0.1,
        high: price + 0.5,
        low: price - 0.5,
      });
    }
    const spec = researchSpecSchema.parse({
      strategy: "dual-breakout",
      start: bars.at(-12)!.date,
      end: bars.at(-1)!.date,
      validationStart: bars.at(-4)!.date,
      holdingDays: 2,
      pool: null,
    });
    const stock = {
      symbol: "sh600000",
      name: "合成测试",
      bars,
      actions: [],
      hash: researchHash(bars),
    };
    const content = {
      version: "research-dataset-1" as const,
      source: "tdx-local" as const,
      root: directory,
      adjustment: "none" as const,
      membership: {
        mode: "current-snapshot" as const,
        symbols: [stock.symbol],
        source: null,
        warning: "合成测试，非市场业绩",
      },
      benchmark: { symbol: "sh000001", bars },
      calendar: bars.map((bar) => bar.date),
      stocks: [stock],
      excluded: [],
      actionCoverage: "missing" as const,
      actionSource: null,
    };
    const dataset: ResearchDataset = {
      ...content,
      capturedAt: 1,
      hash: researchHash(content),
    };
    const evidence = researchMarketEvidenceSchema.parse({
      version: "research-market-evidence-1",
      source: "synthetic fixture",
      exportedAt: 1,
      adjustment: "none",
      corporateActionFree: [
        {
          symbol: stock.symbol,
          start: spec.start,
          end: spec.end,
          evidenceId: "fixture-no-actions",
        },
      ],
      rows: bars
        .filter((bar) => bar.date >= spec.start)
        .map((bar) => ({
          symbol: stock.symbol,
          date: bar.date,
          tradable: true,
          limitUp: bar.high * 2,
          limitDown: bar.low / 2,
          minimumBuy: 100,
          buyStep: 100,
          maximumOrder: 1000000,
          evidenceId: "fixture",
        })),
    });
    const store = new ResearchStore(db);
    const task = store.create(spec, evidence);
    store.saveDataset(task.id, dataset);
    async function run(id: string, cancel = false) {
      const cancellation = new SharedArrayBuffer(4);
      if (cancel) Atomics.store(new Int32Array(cancellation), 0, 1);
      const worker = new Worker(resolve("runtime/research-worker.cjs"), {
        env: { ...process.env, QUANT_DATA_DIR: directory },
        workerData: { id, cancellation },
      });
      workers.push(worker);
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error("research worker timeout")),
          15000,
        );
        worker.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.on(
          "message",
          (message: {
            type: string;
            id?: number;
            args?: Parameters<typeof projectCzsc>;
            error?: string;
          }) => {
            if (message.type === "project" && message.args) {
              projections++;
              void projectCzsc(...message.args).then(
                (result) =>
                  worker.postMessage({
                    type: "projection",
                    id: message.id,
                    result,
                  }),
                (error: unknown) => {
                  clearTimeout(timer);
                  reject(error);
                },
              );
            }
            if (message.type === "done") {
              clearTimeout(timer);
              if (message.error) reject(new Error(message.error));
              else done();
            }
          },
        );
      });
      await worker.terminate();
    }
    await run(task.id);
    expect(store.task(task.id)?.status).toBe("complete");
    const result = store.result(task.id)!;
    expect(
      result.events.some((event) => event.observedDate === signalDate),
    ).toBe(true);
    const development = result.partitions.find(
      (part) => part.partition === "development",
    )!;
    expect(development.simulation!.statistics.count).toBeGreaterThan(0);
    expect(
      development.simulation!.trades.every(
        (trade) => trade.entryDate > trade.event.observedDate,
      ),
    ).toBe(true);
    expect(
      development.simulation!.nav.every(
        (point) => point.date < spec.validationStart,
      ),
    ).toBe(true);
    expect(
      result.partitions
        .find((part) => part.partition === "validation")!
        .simulation!.nav.every((point) => point.date >= spec.validationStart),
    ).toBe(true);
    const repeated = store.retry(task.id);
    await run(repeated.id);
    expect(store.result(repeated.id)?.hash).toBe(result.hash);
    expect(store.dataset(repeated.id)).toEqual(dataset);
    const usageRows = db
      .prepare("SELECT payload FROM records WHERE kind='research-usage'")
      .all() as { payload: string }[];
    const usage = usageRows.map(
      (row) =>
        JSON.parse(
          row.payload,
        ) as import("../src/lib/research-usage").ResearchUsage,
    );
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      kind: "sample-research",
      universeSize: 1,
      candidateCount: 1,
      range: { start: spec.start, end: spec.end },
    });
    expect(usage[0]!.id).not.toBe(usage[1]!.id);
    expect(usage[0]!.configHash).toBe(usage[1]!.configHash);
    const cancelled = store.retry(task.id);
    await run(cancelled.id, true);
    expect(store.task(cancelled.id)?.status).toBe("cancelled");
    expect(store.result(cancelled.id)).toBeNull();
    const chan = store.create({ ...spec, strategy: "czsc" }, evidence);
    store.saveDataset(chan.id, dataset);
    await run(chan.id);
    expect(projections).toBeGreaterThan(1);
    expect(store.task(chan.id)?.status).toBe("complete");
    expect(store.result(chan.id)?.exclusions).toEqual([]);
    const chanRepeat = store.retry(chan.id);
    await run(chanRepeat.id);
    expect(store.result(chanRepeat.id)?.hash).toBe(store.result(chan.id)?.hash);
    // Exercise the ordinary acquisition path as well as cached-snapshot replay.
    const dailyDirectory = join(directory, "tdx/vipdoc/sh/lday");
    await mkdir(dailyDirectory, { recursive: true });
    const binary = Buffer.alloc(bars.length * 32);
    bars.forEach((bar, index) => {
      const offset = index * 32;
      binary.writeUInt32LE(Number(bar.date.replaceAll("-", "")), offset);
      [bar.open, bar.high, bar.low, bar.close].forEach((price, column) =>
        binary.writeUInt32LE(Math.round(price * 100), offset + 4 + column * 4),
      );
      binary.writeFloatLE(bar.amount, offset + 20);
      binary.writeUInt32LE(bar.volume, offset + 24);
    });
    await writeFile(join(dailyDirectory, "sh600000.day"), binary);
    await writeFile(join(dailyDirectory, "sh000001.day"), binary);
    db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(
      "settings",
      "settings",
      JSON.stringify({ tdxRoot: join(directory, "tdx") }),
      Date.now(),
    );
    const acquired = store.create(spec, evidence);
    await run(acquired.id);
    expect(store.task(acquired.id)?.status).toBe("complete");
    expect(
      store.dataset(acquired.id)?.stocks.map((item) => item.symbol),
    ).toEqual(["sh600000"]);
    expect(store.dataset(acquired.id)?.actionCoverage).toBe("missing");
    expect(
      store
        .result(acquired.id)
        ?.events.some((event) => event.observedDate === signalDate),
    ).toBe(true);
    expect(await readFile(join(dailyDirectory, "sh600000.day"))).toEqual(
      binary,
    );
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    await closeCzsc();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
