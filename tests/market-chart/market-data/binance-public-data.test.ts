import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  readFile,
  mkdir,
  writeFile,
  mkdtemp,
  readdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  archiveTimestamp,
  parseArchiveCsv,
  checkedArchive,
  sha256,
} from "../../../src/server/data-sources/binance/public-data";
import {
  backfillPublicData,
  readPublicData,
  publicDataStatus,
  refreshPublicDataLive,
} from "../../../src/server/data-sources/binance/public-data-store";
import { readBars } from "../../../src/server/market/bar-store/read-bars";
import { settings, saveSettings } from "../../../src/server/infra/settings";
import { columnCacheDirectory } from "../../../src/server/market/bar-store/column-cache";

const fixture = (name: string) =>
  readFile(new URL(`../../fixtures/binance/${name}`, import.meta.url), "utf8");
const row = (open: number, step = 86400000) =>
  `${open},10,12,9,11,100,${open + step - 1},1100,42,50,550,0\n`;
const archive = (filename: string, csv: string) => {
  const bytes = zipSync({ [filename.replace(/\.zip$/, ".csv")]: strToU8(csv) });
  return { bytes, checksum: `${sha256(bytes)}  ${filename}\n` };
};
describe("official Binance durable inputs", () => {
  it("fills an unpublished yesterday with labelled REST rows, and refreshes only completed recent bars once per boundary", async () => {
    const root = await mkdtemp(
      join(process.env.QUANT_DATA_DIR!, "binance-tail-"),
    );
    const start = Date.UTC(2025, 0, 1),
      now = start + 86400000 + 600000;
    let archiveCalls = 0,
      liveCalls = 0;
    const fetcher = async (url: string) => {
      if (url.includes("data.binance.vision")) {
        archiveCalls++;
        return new Response("", { status: 404 });
      }
      liveCalls++;
      return new Response(
        JSON.stringify([
          row(start, 300000).trim().split(","),
          row(start + 86400000, 300000)
            .trim()
            .split(","),
          row(now, 300000).trim().split(","),
        ]),
      );
    };
    const r = await backfillPublicData({
      root,
      now,
      fromMonth: "2025-01",
      symbols: ["BTCUSDT"],
      intervals: ["5m"],
      fetcher,
      minimumRequestMs: 0,
    });
    expect(r.series[0]!.status).toBe("incomplete");
    expect(r.series[0]!.rows).toBe(2);
    expect(r.series[0]!.gaps).toHaveLength(1);
    const calls = archiveCalls;
    await refreshPublicDataLive("BTCUSDT", "5m", { root, now, fetcher });
    const tailCalls = liveCalls;
    await refreshPublicDataLive("BTCUSDT", "5m", {
      root,
      now: now + 1,
      fetcher,
    });
    expect(liveCalls).toBe(tailCalls);
    expect(archiveCalls).toBe(calls);
    const manifest = (await publicDataStatus(root)).series.find(
      (s) => s.symbol === "BTCUSDT" && s.interval === "5m",
    )!.manifest!;
    expect(manifest).not.toHaveProperty("files");
    expect(manifest.fileCount).toBe(2);
    expect(manifest.updatedAt.startsWith("2025-")).toBe(false);
  });
  it("reconciles monthly supersession and preserves conflicting live evidence", async () => {
    const root = await mkdtemp(
      join(process.env.QUANT_DATA_DIR!, "binance-month-"),
    );
    const start = Date.UTC(2025, 0, 1),
      now = Date.UTC(2025, 1, 1);
    const dir = join(root, "data/spot/daily/klines/BTCUSDT/1d");
    await mkdir(dir, { recursive: true });
    const live = join(dir, "BTCUSDT-1d-2025-01-01.live.csv");
    const filename = "BTCUSDT-1d-2025-01.zip",
      a = archive(filename, row(start));
    const options = {
      root,
      now,
      fromMonth: "2025-01",
      symbols: ["BTCUSDT"] as const,
      intervals: ["1d"] as const,
      minimumRequestMs: 0,
      fetcher: async (u: string) =>
        new Response(
          u.endsWith(".CHECKSUM")
            ? a.checksum
            : u.endsWith(".zip")
              ? a.bytes
              : "[]",
        ),
    };
    const conflict = row(start).replace(",11,100,", ",10,100,");
    await writeFile(live, conflict);
    await expect(backfillPublicData(options)).rejects.toThrow("disagrees");
    expect(await readFile(live, "utf8")).toBe(conflict);
    await writeFile(live, row(start));
    await backfillPublicData(options);
    expect(await readdir(dir)).not.toContain("BTCUSDT-1d-2025-01-01.live.csv");
  });
  it("reads native4h files through BarStore and preserves durable inputs when the decoded cache is removed", async () => {
    const root = await mkdtemp(
      join(process.env.QUANT_DATA_DIR!, "binance-native4h-"),
    );
    const dir = join(root, "data/spot/monthly/klines/BTCUSDT/4h");
    await mkdir(dir, { recursive: true });
    const filename = "BTCUSDT-4h-2025-01.zip",
      start = Date.UTC(2025, 0, 1),
      a = archive(
        filename,
        row(start, 14400000) + row(start + 14400000, 14400000),
      );
    await writeFile(join(dir, filename), a.bytes);
    await writeFile(join(dir, filename + ".CHECKSUM"), a.checksum);
    saveSettings({ ...settings(), binancePublicDataRoot: root });
    const cache = columnCacheDirectory();
    await mkdir(cache, { recursive: true });
    const before = new Set(await readdir(cache));
    const input = {
      instrument: { market: "crypto" as const, symbol: "cxBTCUSDT" },
      period: "4h" as const,
      cryptoSource: "binance" as const,
      adjustment: "none" as const,
      now: Date.UTC(2025, 1, 1),
    };
    const first = await readBars(input);
    expect(first.source).toBe("binance-public-data");
    expect(first.bars.map((b) => b.date)).toEqual([
      "2025-01-01T04:00:00+00:00",
      "2025-01-01T08:00:00+00:00",
    ]);
    expect((await readBars(input)).bars).toEqual(first.bars);
    for (const file of await readdir(cache))
      if (!before.has(file) && file.endsWith(".bars"))
        await unlink(join(cache, file));
    expect(await readFile(join(dir, filename))).toEqual(Buffer.from(a.bytes));
    expect((await readBars(input)).bars).toEqual(first.bars);
    await writeFile(join(dir, filename), Buffer.from("damaged"));
    await expect(readBars(input)).rejects.toThrow("CHECKSUM");
  });
  it("reads fixed official 12-column millisecond and microsecond fixtures", async () => {
    const a = parseArchiveCsv(await fixture("spot-milliseconds.csv"), "1d");
    const b = parseArchiveCsv(await fixture("spot-microseconds.csv"), "1d");
    expect(a.rows[0]!.bar).toEqual({
      date: "2017-08-17",
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 100,
      amount: 1100,
    });
    expect(b.rows[0]!.bar.date).toBe("2025-01-01");
    expect(b.rows[0]!.closeTime).toBe(1735775999999);
    expect(b.quarantined).toEqual([]);
    expect(archiveTimestamp("1735689600000000")).toBe(1735689600000);
    expect(() => archiveTimestamp("1735689600")).toThrow("precision");
  });
  it("rejects checksum, filename, bad columns, duplicates and invalid OHLC; source time anomalies remain explicit", async () => {
    const csv = await fixture("spot-milliseconds.csv"),
      filename = "BTCUSDT-1d-2017-08.zip",
      a = archive(filename, csv);
    expect(
      checkedArchive(a.bytes, a.checksum, filename, "1d").rows,
    ).toHaveLength(1);
    expect(() =>
      checkedArchive(a.bytes, "0".repeat(64) + "  " + filename, filename, "1d"),
    ).toThrow("CHECKSUM");
    expect(() =>
      checkedArchive(a.bytes, a.checksum, "ETHUSDT-1d-2017-08.zip", "1d"),
    ).toThrow("CHECKSUM");
    expect(() => parseArchiveCsv(csv + csv, "1d")).toThrow("increasing");
    expect(() => parseArchiveCsv(csv.replace(",12,9,", ",8,9,"), "1d")).toThrow(
      "OHLC",
    );
    expect(() =>
      parseArchiveCsv(csv.trim().split(",").slice(0, 11).join(","), "1d"),
    ).toThrow("12 columns");
    const unusual = csv.replace("1503014399999", "1502928000000");
    expect(parseArchiveCsv(unusual, "1d").quarantined).toEqual([
      {
        line: 1,
        openTime: 1502928000000,
        reason: "Non-grid opening or nonstandard closing timestamp",
      },
    ]);
  });
  it("accepts only complete live bars and preserves real missing bars", () => {
    const start = Date.UTC(2025, 0, 1);
    const p = parseArchiveCsv(
      row(start, 300000) + row(start + 600000, 300000),
      "5m",
      start + 900000,
    );
    expect(p.rows).toHaveLength(2);
    expect(
      parseArchiveCsv(row(start, 300000), "5m", start + 299999).rows,
    ).toHaveLength(0);
  });
  it("keeps official ZIPs and checksums intact, resumes without redownloading and replaces checked live rows", async () => {
    const root = await mkdtemp(
      join(process.env.QUANT_DATA_DIR!, "binance-store-"),
    );
    const now = Date.UTC(2025, 0, 2, 0, 1);
    const start = Date.UTC(2025, 0, 1);
    let calls = 0;
    const filename = "BTCUSDT-1d-2025-01-01.zip",
      a = archive(filename, row(start));
    const fetcher = async (url: string) => {
      calls++;
      if (url.endsWith(".CHECKSUM")) return new Response(a.checksum);
      if (url.endsWith(".zip")) return new Response(a.bytes);
      return new Response("[]");
    };
    const dir = join(root, "data/spot/daily/klines/BTCUSDT/1d");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "BTCUSDT-1d-2025-01-01.live.csv"), row(start));
    const result = await backfillPublicData({
      root,
      now,
      fromMonth: "2025-01",
      symbols: ["BTCUSDT"],
      intervals: ["1d"],
      fetcher,
      minimumRequestMs: 0,
    });
    expect(result.series[0]!.rows).toBe(1);
    expect(result.series[0]!.status).toBe("ready");
    expect(result.series[0]!.gaps).toEqual([]);
    expect(await readFile(join(dir, filename))).toEqual(Buffer.from(a.bytes));
    expect(await readdir(dir)).not.toContain("BTCUSDT-1d-2025-01-01.live.csv");
    const first = calls;
    await backfillPublicData({
      root,
      now,
      fromMonth: "2025-01",
      symbols: ["BTCUSDT"],
      intervals: ["1d"],
      fetcher,
      minimumRequestMs: 0,
    });
    expect(calls).toBe(first);
    const before = calls;
    expect((await publicDataStatus(root)).needsBackfill).toBe(true);
    expect(calls).toBe(before);
  });
  it("retries failed checksums, never accepts corrupt bytes or replaces conflicting live data", async () => {
    const root = await mkdtemp(
      join(process.env.QUANT_DATA_DIR!, "binance-store-bad-"),
    );
    const now = Date.UTC(2025, 0, 2);
    let calls = 0;
    const filename = "BTCUSDT-1d-2025-01-01.zip",
      a = archive(filename, row(Date.UTC(2025, 0, 1)));
    const fetcher = async (url: string) => {
      calls++;
      return new Response(
        url.endsWith(".CHECKSUM") ? "0".repeat(64) + "  " + filename : a.bytes,
      );
    };
    await expect(
      backfillPublicData({
        root,
        now,
        fromMonth: "2025-01",
        symbols: ["BTCUSDT"],
        intervals: ["1d"],
        fetcher,
        minimumRequestMs: 0,
      }),
    ).rejects.toThrow("CHECKSUM");
    expect(calls).toBe(4);
    expect((await readPublicData("BTCUSDT", "1d", { root, now })).rows).toEqual(
      [],
    );
    const dir = join(root, "data/spot/daily/klines/BTCUSDT/1d");
    await mkdir(dir, { recursive: true });
    const live = join(dir, "BTCUSDT-1d-2025-01-01.live.csv");
    const csv = row(Date.UTC(2025, 0, 1)).replace(",11,100,", ",10,100,");
    await writeFile(live, csv);
    await expect(
      backfillPublicData({
        root,
        now,
        fromMonth: "2025-01",
        symbols: ["BTCUSDT"],
        intervals: ["1d"],
        fetcher: async (u) =>
          new Response(u.endsWith(".CHECKSUM") ? a.checksum : a.bytes),
        minimumRequestMs: 0,
      }),
    ).rejects.toThrow("disagrees");
    expect(await readFile(live, "utf8")).toBe(csv);
  });
});
