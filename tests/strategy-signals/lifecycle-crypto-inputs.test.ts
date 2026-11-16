import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import type { StrategyObjectInput } from "trading-strategies";
import { readBars } from "~/server/market/bar-store/read-bars";
import {
  backfillPublicData,
  refreshPublicDataLive,
} from "~/server/data-sources/binance/public-data-store";
import { settings, saveSettings } from "~/server/infra/settings";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { evaluateAlertInputs } from "~/server/alerts/inputs";
import { loadPaperInput } from "~/server/paper/inputs";
import { advancePaper } from "~/server/paper/advance";
import { PaperRepository } from "~/server/db/paper-repository";
import frozen from "~/server/data/paper-candidates.json";
import type { FrozenCandidate, PaperAccount } from "~/server/paper/model";
import gbbq from "../fixtures/tdx-gbbq.json";

afterEach(() => vi.unstubAllGlobals());

it("uses the real reader for bare frozen pairs in alerts, regime and paper after daily downtime", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "official-archive");
  const now = Date.parse("2026-11-30T04:00:00Z");
  const start = Date.parse("2026-11-28T00:00:00Z");
  const fixturePath = join(
    process.cwd(),
    "src/server/data/paper-candidates.json",
  );
  const original = await readFile(fixturePath);
  const csv = (step: number) =>
    Array.from(
      { length: ((step === 86400000 ? 2 : 29) * 86400000) / step },
      (_, i) => {
        const open =
          (step === 86400000 ? start : Date.parse("2026-11-01T00:00:00Z")) +
          i * step;
        return `${open},10,12,9,11,100,${open + step - 1},1100,42,50,550,0`;
      },
    ).join("\n") + "\n";
  // These fixed archives use Binance's real twelve-column format and checksum;
  // no reader or instrument validator is mocked.
  const archives = new Map<string, { bytes: Uint8Array; checksum: string }>();
  for (const pair of ["BTCUSDT", "ETHUSDT"])
    for (const interval of ["1d", "4h"] as const) {
      const name = `${pair}-${interval}-2026-11.zip`;
      const bytes = zipSync({
        [name.replace(".zip", ".csv")]: strToU8(
          csv(interval === "1d" ? 86400000 : 14400000),
        ),
      });
      const checksum = `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
      archives.set(name, { bytes, checksum });
      const dir = join(root, "data/spot/monthly/klines", pair, interval);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), bytes);
      await writeFile(join(dir, name + ".CHECKSUM"), checksum);
    }
  await backfillPublicData({
    root,
    now,
    fromMonth: "2026-11",
    symbols: ["BTCUSDT", "ETHUSDT"],
    intervals: ["1d", "4h"],
    minimumRequestMs: 0,
    fetcher: async (url) => {
      const name = url.split("/").at(-1)!;
      const source = archives.get(name.replace(/\.CHECKSUM$/, ""));
      return source
        ? new Response(
            name.endsWith(".CHECKSUM")
              ? source.checksum
              : new Uint8Array(source.bytes).buffer,
          )
        : url.includes("/api/v3/")
          ? new Response("[]")
          : new Response("", { status: 404 });
    },
  });
  saveSettings({ ...settings(), binancePublicDataRoot: root });
  for (const symbol of ["BTCUSDT", "ETHUSDT"])
    for (const interval of ["1d", "4h"] as const)
      await refreshPublicDataLive(symbol, interval, {
        root,
        now,
        fetcher: async () => new Response("[]"),
      });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]")),
  );
  await expect(
    readBars({
      instrument: { market: "crypto", symbol: "BTCUSDT" },
      period: "day",
      adjustment: "none",
      now,
    }),
  ).rejects.toThrow("标的与市场不匹配");
  const strategy: StrategyObjectInput = {
    id: "daily-real-reader",
    version: 1,
    market: "crypto",
    period: "day",
    universe: { kind: "symbols", symbols: ["BTCUSDT", "ETHUSDT"] },
    entry: { kind: "constant", value: true },
    exit: {},
    sizing: { kind: "weight", weight: 0.5 },
    sleeve: "swing",
  };
  const db = new Database(":memory:");
  try {
    migrate(db);
    const repo = new AlertRepository(db);
    repo.strategies.saveStrategy(strategy);
    repo.saveState(`strategy:${strategy.id}:1`, { live: true });
    const checked = await readBars({
      instrument: { market: "crypto", symbol: "cxBTCUSDT" },
      period: "day",
      adjustment: "none",
      now,
      live: true,
      limit: 3000,
    });
    expect(checked.bars.map((b) => b.date)).toEqual([
      "2026-11-28",
      "2026-11-29",
    ]);
    const result = await evaluateAlertInputs("crypto", now, repo);
    const entries = result.proposals.filter(
      (p) => p.event.strategyId === strategy.id,
    );
    expect(entries.map((p) => p.event.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(
      entries.every(
        (p) => p.event.bar === "2026-11-29" && now - p.completedAt < p.windowMs,
      ),
    ).toBe(true);
    expect(entries.every((p) => p.windowMs === 12 * 3600000)).toBe(true);
    expect(
      result.states.filter((s) => s.id.startsWith("regime:crypto:")),
    ).toHaveLength(2);
    expect(
      result.states
        .filter((s) => s.id.startsWith("data-gap:"))
        .every((s) => (s.value as { resolved?: boolean }).resolved),
    ).toBe(true);
    const account: PaperAccount = {
      id: "paper-real-reader",
      market: "crypto",
      currency: "USDT",
      sleeve: "swing",
      startedAt: start,
      initial: 10000,
      candidates: [
        { ...frozen.candidates[0], strategy } as unknown as FrozenCandidate,
      ],
      mirror: { venue: "off" },
      mirrorRevision: "fixture",
      revision: 0,
      lastBar: null,
      lastRun: null,
      error: null,
      summary: null,
    };
    const paper = new PaperRepository(db);
    paper.create(account);
    const input = await loadPaperInput(account, now);
    expect(input?.request.instruments.map((i) => i.symbol)).toEqual([
      "BTCUSDT",
      "ETHUSDT",
    ]);
    expect(input!.request.instruments[0]!.bars.map((b) => b.date)).toEqual([
      "2026-11-28",
      "2026-11-29",
    ]);
    expect(advancePaper(paper, account.id, input!, now).advanced).toBe(2);
    expect(paper.account(account.id)?.lastBar).toBe("2026-11-29");
    expect(await readFile(fixturePath)).toEqual(original);
  } finally {
    db.close();
  }
});

it("advances real local historical daily bars without old receipts and gates only today's bar", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "local-paper-input");
  const dates = ["2026-11-13", "2026-11-16"];
  const now = Date.parse("2026-11-16T17:05:00+08:00");
  const bytes = Buffer.alloc(64);
  dates.forEach((date, i) => {
    bytes.writeUInt32LE(Number(date.replaceAll("-", "")), i * 32);
    for (const offset of [4, 8, 12, 16])
      bytes.writeUInt32LE(1000, i * 32 + offset);
    bytes.writeFloatLE(10000, i * 32 + 20);
    bytes.writeUInt32LE(1000, i * 32 + 24);
  });
  await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
  for (const symbol of ["sh000906", "sh600000"])
    await writeFile(join(root, "vipdoc/sh/lday", symbol + ".day"), bytes);
  await mkdir(join(root, "T0002/hq_cache"), { recursive: true });
  await writeFile(
    join(root, "T0002/hq_cache/gbbq"),
    Buffer.from(gbbq.gbbqBase64, "base64"),
  );
  saveSettings({ ...settings(), tdxRoot: root, calendar: dates });
  const strategy: StrategyObjectInput = {
    id: "historical-local-paper",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "constant", value: true },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  };
  const account: PaperAccount = {
    id: "paper-local-input",
    market: "cn-equity",
    currency: "CNY",
    sleeve: "swing",
    startedAt: Date.parse("2026-11-13T00:00:00Z"),
    initial: 10000,
    candidates: [
      { ...frozen.candidates[0], strategy } as unknown as FrozenCandidate,
    ],
    mirror: { venue: "off" },
    mirrorRevision: "fixture",
    revision: 0,
    lastBar: null,
    lastRun: null,
    error: null,
    summary: null,
  };
  const db = new Database(":memory:");
  try {
    migrate(db);
    const repo = new PaperRepository(db);
    repo.create(account);
    const historical = await loadPaperInput(account, now);
    expect(historical?.readyDates).toEqual(["2026-11-13"]);
    expect(advancePaper(repo, account.id, historical!, now).advanced).toBe(1);
    expect(repo.account(account.id)?.lastBar).toBe("2026-11-13");
    await writeFile(
      join(process.env.QUANT_DATA_DIR!, "download-2026-11-16-close.json"),
      JSON.stringify({
        date: "2026-11-16",
        phase: "close",
        completedAt: now,
        exitCode: 0,
      }),
    );
    const current = await loadPaperInput(repo.account(account.id)!, now);
    expect(current?.readyDates).toEqual(["2026-11-16"]);
    expect(advancePaper(repo, account.id, current!, now).advanced).toBe(1);
    expect(repo.account(account.id)?.lastBar).toBe("2026-11-16");
  } finally {
    db.close();
  }
});
