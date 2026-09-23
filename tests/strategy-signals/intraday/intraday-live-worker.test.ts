import { Worker } from "node:worker_threads";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { build } from "esbuild";
import { expect, it } from "vitest";
import valid from "../../fixtures/breakout-valid.json";
import { migrate } from "../../../src/server/db/migrations";
import { RpsStore } from "../../../src/server/screening/rps-store";
import { rpsDay } from "../../rps-fixture";
import { intradayConfigSchema } from "../../../src/lib/strategy-facts/intraday-schedule";
import { previewSlots } from "../../../src/lib/research/analysis/intraday-preview";
import { projectCzsc, closeCzsc } from "../../../src/server/strategies/chan/czsc";
import { IntradayStore } from "../../../src/server/monitoring/intraday-store";

it("runs captured intraday signals through the actual worker and host DLL queue, then confirms at close", async () => {
  await mkdir(".test-data", { recursive: true });
  const directory = await mkdtemp(resolve(".test-data/intraday-native-"));
  const root = join(directory, "tdx");
  const db = new Database(join(directory, "quant.sqlite"));
  migrate(db);
  const workers: Worker[] = [];
  try {
    await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
    await mkdir(join(root, "vipdoc/sh/fzline"), { recursive: true });
    const bars = valid.bars;
    const today = bars.at(-1)!;
    const previous = bars.at(-2)!.date;
    const daily = Buffer.alloc((bars.length - 1) * 32);
    bars.slice(0, -1).forEach((bar, i) => {
      const offset = i * 32;
      daily.writeUInt32LE(Number(bar.date.replaceAll("-", "")), offset);
      [bar.open, bar.high, bar.low, bar.close].forEach((price, n) =>
        daily.writeUInt32LE(Math.round(price * 100), offset + 4 + n * 4),
      );
      daily.writeFloatLE(bar.amount, offset + 20);
      daily.writeUInt32LE(bar.volume, offset + 24);
    });
    await writeFile(join(root, "vipdoc/sh/lday/sh600000.day"), daily);
    const times = previewSlots("15:00"),
      minutes = Buffer.alloc(times.length * 32);
    times.forEach((time, i) => {
      const offset = i * 32;
      minutes.writeUInt16LE(((2025 - 2004) << 11) + 307, offset);
      minutes.writeUInt16LE(
        Number(time.slice(0, 2)) * 60 + Number(time.slice(3)),
        offset + 2,
      );
      [today.open, today.high, today.low, today.close].forEach((price, n) =>
        minutes.writeFloatLE(price, offset + 4 + n * 4),
      );
      minutes.writeFloatLE(today.amount / 44, offset + 20);
      minutes.writeUInt32LE(Math.ceil(today.volume / 44), offset + 24);
    });
    await writeFile(join(root, "vipdoc/sh/fzline/sh600000.lc5"), minutes);
    const insert = db.prepare("INSERT INTO records VALUES (?,?,?,0)");
    insert.run(
      "settings",
      "settings",
      JSON.stringify({ tdxRoot: root, calendar: [previous, today.date] }),
    );
    insert.run(
      "intraday-config",
      "intraday-config",
      JSON.stringify(
        intradayConfigSchema.parse({
          enabled: true,
          pool: null,
          minimumRps: 0,
        }),
      ),
    );
    const rps = rpsDay();
    rps.day.date = previous;
    rps.day.source.root = root;
    new RpsStore(db).saveDay(rps.day, [
      { symbol: "sh600000", values: rps.rows[0]!.values },
    ]);
    async function tick(time: string) {
      const path = join(directory, `worker-${time.replace(":", "")}.cjs`);
      const now = Date.parse(`${today.date}T${time}:01+08:00`);
      await build({
        entryPoints: ["src/server/monitoring/intraday-worker.ts"],
        outfile: path,
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["better-sqlite3", "koffi"],
        target: "node22",
        banner: { js: `Date.now = () => ${now};` },
      });
      const worker = new Worker(path, {
        env: { ...process.env, QUANT_DATA_DIR: directory },
      });
      workers.push(worker);
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error("native preview timeout")),
          30000,
        );
        worker.on(
          "message",
          (message: {
            type: string;
            id: number;
            args: Parameters<typeof projectCzsc>;
            error?: string;
          }) => {
            if (message.type === "project")
              void projectCzsc(...message.args).then(
                (result) =>
                  worker.postMessage({
                    type: "projection",
                    id: message.id,
                    result,
                  }),
                reject,
              );
            if (message.type === "done") {
              clearTimeout(timer);
              if (message.error) reject(new Error(message.error));
              else done();
            }
          },
        );
        worker.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.postMessage({ type: "run" });
      });
      await worker.terminate();
    }
    await tick("14:40");
    const store = new IntradayStore(db);
    const row = store.page()[0];
    expect(
      row,
      JSON.stringify(
        db
          .prepare("SELECT payload FROM records WHERE kind='intraday-run'")
          .all(),
      ),
    ).toBeDefined();
    expect(
      row!.value.signals.some((signal) => signal.strategy === "dual-breakout"),
    ).toBe(true);
    expect(row!.attempts).toHaveLength(0);
    await tick("15:10");
    expect(store.observation(row!.id)).toEqual(row!.value);
    expect(
      store
        .attempts(row!.id)
        .at(-1)
        ?.signals.find((signal) => signal.key.startsWith("dual-breakout"))
        ?.status,
    ).toBe("confirmed");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM records WHERE kind LIKE '%delivery%'",
        )
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    for (const worker of workers) await worker.terminate();
    await closeCzsc();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
