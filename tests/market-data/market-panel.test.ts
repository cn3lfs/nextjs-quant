import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readSnapshot,
  readTailSnapshot,
  readWindowSnapshot,
  scan,
  GBBQ_RECORD_SIZE,
  parseGbbqFile,
} from "tstdx/local";
import { localBars } from "~/server/market/bar-store/local-source";
import {
  MarketPanelStore,
  readWindowSnapshot as readResearchWindow,
  MarketPanelBusyError,
  missingAtoms,
  panelFlags,
  openMarketPanel,
  type MarketPanelHandle,
} from "~/server/market/market-panel";
import gbbq from "../fixtures/tdx-gbbq.json";
// Exercise the real local reader and cache without opening the application's
// unrelated imported-package database.
vi.mock("~/server/market/bar-store/package-import", () => ({
  readFullDaySnapshot: () => null,
  fullDayRepairsSameDate: () => false,
}));

const stock = "sz000001",
  etf = "sh510300",
  unlisted = "sh600123";
const dates: string[] = [];
for (let n = 0; dates.length < 41; n++) {
  const day = new Date(Date.UTC(1991, 3, 8 + n));
  if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
    dates.push(day.toISOString().slice(0, 10));
}
const ex = dates.indexOf("1991-05-02");
const gbbqPath = "T0002/hq_cache/gbbq";
const gbbqBytes = Buffer.from(gbbq.gbbqBase64, "base64");
let dir: string, root: string, data: string, store: MarketPanelStore;
let handles: MarketPanelHandle[], sourceFiles: string[];
function keep(h: MarketPanelHandle) {
  handles.push(h);
  return h;
}
function source(file: string, b: Buffer, sourceRoot = root) {
  const path = join(sourceRoot, file);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) chmodSync(path, 0o600);
  else sourceFiles.push(path);
  writeFileSync(path, b);
  chmodSync(path, 0o444);
  return path;
}
function appendGbbqRecord(record: string) {
  const bytes = Buffer.concat([gbbqBytes, Buffer.from(record, "base64")]);
  expect(bytes.length - gbbqBytes.length).toBe(GBBQ_RECORD_SIZE);
  bytes.writeUInt32LE(gbbqBytes.readUInt32LE(0) + 1);
  return bytes;
}
function daily(s: string, indexes: number[]) {
  const b = Buffer.alloc(indexes.length * 32);
  indexes.forEach((d, i) => {
    const at = i * 32,
      price = s === etf ? 1234 + d : s === stock ? 1000 + d : 2200;
    b.writeUInt32LE(+dates[d]!.replaceAll("-", ""), at);
    const flat = s === stock && d === 31;
    [
      price,
      price + (flat ? 0 : 3),
      price - (flat ? 0 : 2),
      price + (flat ? 0 : 1),
    ].forEach((p, j) => b.writeUInt32LE(p, at + 4 + j * 4));
    b.writeFloatLE(d === 12 && s === stock ? 0 : 110011.25 + d, at + 20);
    b.writeUInt32LE(d === 12 && s === stock ? 0 : 100003 + d, at + 24);
  });
  return source(`vipdoc/${s.slice(0, 2)}/lday/${s}.day`, b);
}
function gp(group: number, d: number, x: number, y = 0) {
  const b = Buffer.alloc(13);
  b[0] = group;
  b.writeUInt32LE(+dates[d]!.replaceAll("-", ""), 1);
  b.writeFloatLE(x, 5);
  b.writeFloatLE(y, 9);
  return b;
}
function report() {
  const b = Buffer.alloc(31 + 314 * 4);
  b.writeInt16LE(1);
  b.writeUInt32LE(19901231, 2);
  b.writeUInt16LE(1, 6);
  b.writeUInt32LE(314 * 4, 12);
  b.write("000001", 20);
  b.writeUInt32LE(31, 27);
  b.writeFloatLE(12345, 31 + 39 * 4);
  b.writeFloatLE(+dates[8]!.slice(2).replaceAll("-", ""), 31 + 313 * 4);
  return b;
}
beforeEach(() => {
  dir = mkdtempSync(join(process.env.QUANT_DATA_DIR!, "panel-test-"));
  root = join(dir, "source");
  data = join(dir, "data");
  store = new MarketPanelStore(root);
  vi.stubEnv("QUANT_DATA_DIR", data);
  handles = [];
  sourceFiles = [];
  daily(
    stock,
    dates.map((_, i) => i).filter((i) => i !== 10),
  );
  daily(
    etf,
    dates.map((_, i) => i),
  );
  daily(unlisted, [37, 38, 39, 40]);
  // A fixed encrypted company-action fixture exercises the real decoder;
  // all quote prices, GP evidence and release dates are independently generated.
  source(gbbqPath, gbbqBytes);
  source(
    "vipdoc/cw/gp" + stock + ".dat",
    Buffer.concat([
      gp(16, 3, 42, 999),
      gp(16, 4, 42),
      gp(16, 4, 43),
      gp(29, 7, 0, 2),
      gp(29, 11, 1, 0),
      gp(29, 16, 0, 4),
      gp(15, 31, 2),
    ]),
  );
  source("vipdoc/cw/gpcw19901231.dat", report());
});
afterEach(() => {
  for (const h of handles) h.close();
  for (const path of sourceFiles) if (existsSync(path)) chmodSync(path, 0o600);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("MarketPanelStore", () => {
  it("默认纳入新代码段 ETF 和常用指数，排除同为三位价格精度的 LOF 与 REIT", async () => {
    const additional = ["sh520660", "sh530050", "sz158031", "sz399006"];
    for (const symbol of [...additional, "sz160119", "sh508000"])
      daily(symbol, [0, 1]);
    const handle = keep(await store.build());
    expect(
      handle.manifest.symbols
        .filter(({ symbol }) => additional.includes(symbol))
        .map(({ symbol, kind, priceScale }) => [symbol, kind, priceScale]),
    ).toEqual([
      ["sh520660", "etf", 1000],
      ["sh530050", "etf", 1000],
      ["sz158031", "etf", 1000],
      ["sz399006", "index", 100],
    ]);
    expect(
      handle.manifest.symbols.some(({ symbol }) =>
        ["sz160119", "sh508000"].includes(symbol),
      ),
    ).toBe(false);
  });

  it("转置第二批证券及最后一个非整批时保持跨块价格和有效位图", async () => {
    for (let i = 0; i < 67; i++)
      daily("sh" + String(600200 + i), [i % 17, 32 + (i % 8)]);
    const h = keep(await store.build());
    expect(h.manifest.symbols.length).toBe(70);
    for (const d of [0, 16, 32, 39]) {
      const row = h.crossSection(dates[d]!);
      for (let i = 0; i < 67; i++) {
        const s = h.manifest.symbols.findIndex(
          (m) => m.symbol === "sh" + String(600200 + i),
        );
        const present = d === i % 17 || d === 32 + (i % 8);
        expect(row.valid[s]).toBe(Number(present));
        expect(row.openAtoms[s]).toBe(present ? 2200 : missingAtoms);
      }
    }
  });
  it("同一报告期的重码财报退出 PIT，单日行业归属不回填至历史日线", async () => {
    const raw = report();
    const rowBytes = 314 * 4;
    const b = Buffer.alloc(42 + rowBytes * 2);
    raw.copy(b, 0, 0, 20);
    b.writeUInt16LE(2, 6);
    for (let i = 0; i < 2; i++) {
      b.write("000001", 20 + 11 * i);
      b.writeUInt32LE(42 + rowBytes * i, 27 + 11 * i);
      raw.copy(b, 42 + rowBytes * i, 31);
    }
    source("vipdoc/cw/gpcw19901231.dat", b);
    source("Blocks/申万行业/银行.txt", Buffer.from("SZ000001\n"));
    const h = keep(await store.build());
    expect(h.manifest.duplicateReportGroups).toBe(1);
    expect(h.events(stock).some((e) => e.kind === "report")).toBe(false);
    expect(h.manifest.industries).toMatchObject([{ name: "银行", code: 1780 }]);
    expect(
      h.manifest.symbols.find((s) => s.symbol === stock)?.industryCode,
    ).toBe(1780);
    expect(h.sliceSymbol(stock).industryCode.every((code) => code === 0)).toBe(
      true,
    );
  });
  it("冷建、热刷新与按 ID 重开逐根匹配股票和 ETF 原始 OHLC、量额，跨过第 32 日", async () => {
    const cold = keep(await store.build()),
      hot = keep(await store.build()),
      opened = keep(openMarketPanel(cold.snapshotId, root));
    expect(hot.snapshotId).toBe(cold.snapshotId);
    expect(opened.manifest.dates).toEqual(dates);
    expect(cold.manifest.chunks).toHaveLength(2);
    expect(cold.manifest.recordBytes).toBe(52);
    const bin = readFileSync(
      join(store.directory, "snap-" + cold.snapshotId, "panel.bin"),
    );
    expect(bin.subarray(0, 8).toString()).toBe("MKTPAN01");
    expect([8, 12, 16].map((at) => bin.readUInt32LE(at))).toEqual([1, 32, 52]);
    expect(bin.length).toBe(32 + 2 * (3 * 32 * 52 + 3 * 4));
    for (const s of [stock, etf, unlisted]) {
      const expected = await readSnapshot(root, s, "day", { allowFunds: true });
      const symbolIndex = opened.manifest.symbols.findIndex(
        (m) => m.symbol === s,
      );
      const scale = s === etf ? 1000 : 100;
      expect(opened.manifest.symbols[symbolIndex]!.priceScale).toBe(scale);
      for (const h of [cold, hot, opened]) {
        const seq = h.sliceSymbol(s);
        for (const b of expected.bars) {
          const i = dates.indexOf(b.date);
          const row = h.crossSection(b.date);
          for (const k of ["open", "high", "low", "close"] as const) {
            expect(seq[`${k}Atoms`][i]! / scale).toBe(b[k]);
            expect(row[`${k}Atoms`][symbolIndex]! / scale).toBe(b[k]);
          }
          expect([
            seq.volume[i],
            seq.amount[i],
            row.volume[symbolIndex],
            row.amount[symbolIndex],
          ]).toEqual([b.volume, b.amount, b.volume, b.amount]);
        }
      }
    }
    const rows = [...cold.sliceDates(dates[30]!, dates[33]!)];
    expect(rows.map((r) => r.date)).toEqual(dates.slice(30, 34));
    const etfIndex = cold.manifest.symbols.findIndex((s) => s.symbol === etf);
    expect(rows.map((r) => r.openAtoms[etfIndex])).toEqual([
      1264, 1265, 1266, 1267,
    ]);
    rows[0]!.openAtoms.fill(-1);
    expect(cold.crossSection(dates[30]!).openAtoms[etfIndex]).toBe(1264);
  });
  it("分红送股只在除权日改变因子，按历史 T 归一的完整前缀逐项相等", async () => {
    const full = keep(await store.build());
    const all = full.sliceSymbol(stock);
    const prevClose = all.closeAtoms[ex - 1]! / 100;
    // 每股派 0.30、送 0.4 股，除权参考价 = (昨收 − 0.30) / 1.4。
    expect(all.adjFactor[ex - 1]).toBe(1);
    expect(all.adjFactor[ex]).toBe(
      Math.fround(prevClose / ((prevClose - 0.3) / 1.4)),
    );
    for (const end of [ex - 1, ex + 1]) {
      const truncated = keep(await store.build({ through: dates[end] }));
      const prefix = truncated.sliceSymbol(stock);
      expect(prefix.adjFactor).toEqual(all.adjFactor.slice(0, end + 1));
      const anchor = all.adjFactor[end]!;
      expect(prefix.adjFactor.map((f) => f / prefix.adjFactor[end]!)).toEqual(
        all.adjFactor.slice(0, end + 1).map((f) => f / anchor),
      );
      expect(
        truncated.events(stock).every((e) => e.availableFrom <= dates[end]!),
      ).toBe(true);
    }
    expect(
      full
        .events(stock, dates[ex]!)
        .some((e) => e.kind === "gbbq" && e.availableFrom === dates[ex]),
    ).toBe(true);
    // An open reader stays bound to its generation after directory retention.
    expect(full.crossSection(dates[40]!).volume.length).toBe(3);
    expect(
      readdirSync(store.directory).filter((f) => f.startsWith("snap-")),
    ).toHaveLength(2);

    const cutoff = dates[ex + 1]!;
    const baseline = keep(store.openLatest()).sliceSymbol(stock).adjFactor;
    const futureRoot = join(dir, "future-source");
    for (const path of sourceFiles.slice()) {
      const file = relative(root, path);
      source(file, readFileSync(path), futureRoot);
    }
    // 1991-05-07 的 sz000001 除权记录，送股比例为 +Infinity。
    const bad = appendGbbqRecord("YxIksPMRyam100axupFWcoqTs5qM/ZuGfwAAAAA=");
    expect(parseGbbqFile(bad).issues).toEqual([
      { offset: gbbqBytes.length, symbol: stock, reason: "事件数值非法" },
    ]);
    source(gbbqPath, bad, futureRoot);
    const futureStore = new MarketPanelStore(futureRoot);
    const prefix = keep(await futureStore.build({ through: cutoff }));
    expect(prefix.manifest.dates.at(-1)).toBe(cutoff);
    expect(prefix.manifest.gbbqIssues).toBe(0);
    expect(Buffer.from(prefix.sliceSymbol(stock).adjFactor.buffer)).toEqual(
      Buffer.from(baseline.buffer),
    );
    const atEvent = keep(await futureStore.build({ through: "1991-05-07" }));
    expect(atEvent.manifest.gbbqIssues).toBe(1);
    expect(atEvent.sliceSymbol(stock).adjFactor.every(Number.isNaN)).toBe(true);
    expect(atEvent.sliceSymbol(etf).adjFactor[0]).toBe(1);
  });
  it("日期非法的 GBBQ 问题阻断该证券，无法归因的尾部字节阻断全市场复权", async () => {
    // sz000001 的除权记录含非法日历日期 1991-02-31。
    const bad = appendGbbqRecord("YxIksPMRyak6jPOkQSGW0IqTs5qM/ZuGfwAAAAA=");
    expect(parseGbbqFile(bad).issues).toEqual([
      { offset: gbbqBytes.length, symbol: stock, reason: "事件日期非法" },
    ]);
    source(gbbqPath, bad);
    const through = dates[ex + 1]!;
    const undated = keep(await store.build({ through }));
    expect(undated.sliceSymbol(stock).adjFactor.every(Number.isNaN)).toBe(true);
    expect(undated.sliceSymbol(etf).adjFactor[0]).toBe(1);

    source(gbbqPath, Buffer.concat([gbbqBytes, Buffer.from([0xff])]));
    const unattributed = keep(await store.build({ through }));
    expect(unattributed.sliceSymbol(stock).adjFactor.every(Number.isNaN)).toBe(
      true,
    );
    expect(unattributed.sliceSymbol(etf).adjFactor.every(Number.isNaN)).toBe(
      true,
    );
  });
  it("股票和 ETF 正量零额保留原始价量，零额和负额对因子均为缺失", async () => {
    const dateIndex = 1;
    const negativeAmountDates = [
      [stock, 3],
      [etf, 4],
    ] as const;
    for (const [symbol, negativeDate] of negativeAmountDates) {
      const file = `vipdoc/${symbol.slice(0, 2)}/lday/${symbol}.day`;
      const bytes = readFileSync(join(root, file));
      bytes.writeFloatLE(0, dateIndex * 32 + 20);
      bytes.writeFloatLE(-1, negativeDate * 32 + 20);
      source(file, bytes);
    }
    const h = keep(await store.build());
    const row = h.crossSection(dates[dateIndex]!);
    const factor = h.factor("amount/v1", (_date, section) =>
      Float32Array.from(section.amount),
    );
    for (const [symbol, negativeDate] of negativeAmountDates) {
      const s = h.manifest.symbols.findIndex((m) => m.symbol === symbol);
      const seq = h.sliceSymbol(symbol);
      expect(seq.closeAtoms[dateIndex]).toBe(symbol === stock ? 1002 : 1236);
      expect(seq.volume[dateIndex]).toBe(100004);
      expect(seq.amount[dateIndex]).toBeNaN();
      expect(row.amount[s]).toBeNaN();
      expect(row.valid[s]).toBe(0);
      expect(
        row.statusFlags[s]! & (panelFlags.valid | panelFlags.zeroVolume),
      ).toBe(0);
      expect(factor[dateIndex * h.manifest.symbols.length + s]).toBeNaN();
      expect(seq.prevCloseAtoms[dateIndex + 1]).toBe(seq.closeAtoms[dateIndex]);
      expect(seq.amount[negativeDate]).toBeNaN();
      expect(seq.valid[negativeDate]).toBe(0);
      expect(factor[negativeDate * h.manifest.symbols.length + s]).toBeNaN();
    }
  });
  it("缺行与零量各有证据位，GP16 单位、GP29 生效日、PIT 公告后一交易日均可核对", async () => {
    const h = keep(await store.build());
    const seq = h.sliceSymbol(stock);
    expect(seq.valid[10]).toBe(0);
    expect(seq.volume[10]).toBeNaN();
    expect(seq.openAtoms[10]).toBe(missingAtoms);
    expect(seq.prevCloseAtoms[0]).toBe(missingAtoms);
    expect(seq.valid[12]).toBe(0);
    expect(seq.volume[12]).toBe(0);
    expect(seq.adjFactor[12]).toBeNaN();
    expect(seq.prevCloseAtoms[13]).toBe(seq.closeAtoms[11]);
    expect(seq.statusFlags[12]! & panelFlags.zeroVolume).toBe(
      panelFlags.zeroVolume,
    );
    expect(seq.statusFlags[10]! & panelFlags.gp29).toBe(0);
    expect(seq.statusFlags[11]! & panelFlags.resumed).toBe(panelFlags.resumed);
    expect(seq.statusFlags[6]! & panelFlags.stKnown).toBe(0);
    expect(seq.statusFlags[7]! & panelFlags.st).toBe(panelFlags.st);
    expect(seq.statusFlags[16]! & panelFlags.st).toBe(0);
    expect(seq.statusFlags[31]! & panelFlags.onePriceLimitUp).toBe(
      panelFlags.onePriceLimitUp,
    );
    expect(seq.marketCap[3]).toBe(420000);
    expect(seq.marketCap[4]).toBeNaN();
    expect(seq.turnover.every(Number.isNaN)).toBe(true);
    expect(
      h.events(stock, dates[8]!).filter((e) => e.kind === "report"),
    ).toEqual([]);
    expect(
      h.events(stock, dates[9]!).filter((e) => e.kind === "report"),
    ).toMatchObject([
      {
        reportDate: "1990-12-31",
        availableFrom: dates[9],
        raw: { assets: 12345, revenue: null, netProfit: null, equity: null },
      },
    ]);
    const s = h.manifest.symbols.findIndex((m) => m.symbol === stock);
    const compute = vi.fn((_d: string, row: { volume: Float64Array }) =>
      Float32Array.from(row.volume),
    );
    const a = h.factor("volume/v1", compute);
    expect(a[10 * 3 + s]).toBeNaN();
    expect(a[12 * 3 + s]).toBeNaN();
    a.fill(-1);
    expect(h.factor("volume/v1", compute)[s]).toBe(100003);
    expect(compute).toHaveBeenCalledTimes(dates.length);
  });
  it("同一时刻只有一个写者，子进程退出释放锁，失败刷新保留原指针并回收孤立临时目录", async () => {
    const cold = store.build();
    await expect(store.build()).rejects.toBeInstanceOf(MarketPanelBusyError);
    const first = keep(await cold);
    const stray = join(
      store.directory,
      "stage-12345678-1234-1234-1234-123456789abc.tmp",
    );
    mkdirSync(stray);
    writeFileSync(join(stray, "bands.tmp"), "partial");
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "const d=new (require('better-sqlite3'))(process.argv[1]); d.exec('BEGIN EXCLUSIVE'); process.exit(19)",
        join(store.directory, "writer.lock"),
      ],
      { windowsHide: true },
    );
    expect(child.status).toBe(19);
    const path = source("vipdoc/cw/gp" + stock + ".dat", Buffer.alloc(12));
    await expect(store.build()).rejects.toThrow(/截断/);
    expect(keep(store.openLatest()).snapshotId).toBe(first.snapshotId);
    expect(existsSync(stray)).toBe(false);
    const b = gp(16, 3, 18);
    source("vipdoc/cw/gp" + stock + ".dat", b);
    const publishing = store.build();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(keep(store.openLatest()).snapshotId).toBe(first.snapshotId);
    const next = keep(await publishing);
    const mtime = statSync(path).mtime;
    const changed = gp(16, 3, 81);
    source("vipdoc/cw/gp" + stock + ".dat", changed);
    chmodSync(path, 0o600);
    utimesSync(path, mtime, mtime);
    chmodSync(path, 0o444);
    const updated = keep(await store.build());
    expect(updated.snapshotId).not.toBe(next.snapshotId);
    expect(next.sliceSymbol(stock).marketCap[3]).toBe(180000);
    expect(updated.sliceSymbol(stock).marketCap[3]).toBe(810000);
    expect(
      readdirSync(store.directory)
        .filter((name) => name.startsWith("snap-"))
        .sort(),
    ).toEqual([next, updated].map((h) => "snap-" + h.snapshotId).sort());
    expect(first.sliceSymbol(stock).marketCap[3]).toBe(420000);
  });
  it("拒绝非法输入、篡改的数据块、事件及清单，读源目录内的缓存和链接均在写入前拒绝", async () => {
    await expect(store.build({ symbols: ["../escape"] })).rejects.toThrow();
    await expect(store.build({ through: "1991-02-31" })).rejects.toThrow();
    expect(() => store.open("../evil")).toThrow();
    vi.stubEnv("QUANT_DATA_DIR", join(root, "missing"));
    await expect(store.build()).rejects.toThrow(/只读目录/);
    expect(existsSync(join(root, "missing"))).toBe(false);
    const linkedData = join(dir, "linked-data");
    vi.stubEnv("QUANT_DATA_DIR", linkedData);
    mkdirSync(linkedData, { recursive: true });
    const link = join(linkedData, "market-panel");
    symlinkSync(root, link, "junction");
    await expect(store.build()).rejects.toThrow();
    rmSync(link);
    vi.stubEnv("QUANT_DATA_DIR", data);
    const h = keep(await store.build());
    const p = join(store.directory, "snap-" + h.snapshotId);
    for (const name of ["panel.bin", "events.jsonl", "manifest.json"]) {
      const file = join(p, name),
        bytes = readFileSync(file),
        corrupt = Buffer.from(bytes);
      if (name === "manifest.json") {
        writeFileSync(file, bytes.toString().replace("MKTPAN01", "MKTPAN02"));
        expect(() => store.openLatest()).toThrow(/校验/);
      } else {
        const i =
          name === "panel.bin"
            ? 32
            : h.manifest.symbols.find((s) => s.symbol === stock)!.eventOffset;
        corrupt[i] = corrupt[i]! ^ 1;
        writeFileSync(file, corrupt);
        const reopened = keep(store.openLatest());
        expect(() =>
          name === "panel.bin"
            ? reopened.crossSection(dates[0]!)
            : reopened.events(stock),
        ).toThrow(/校验/);
      }
      writeFileSync(file, bytes);
    }
  });
  it.each(["panel.bin", "manifest.json", "events.jsonl"])(
    "同源刷新检测到等长损坏的 %s 后原子发布可完整校验的新快照",
    async (name) => {
      const original = keep(await store.build());
      const path = join(store.directory, "snap-" + original.snapshotId, name);
      const bytes = readFileSync(path);
      const offset = name === "panel.bin" ? bytes.length - 1 : 0;
      bytes[offset] = bytes[offset]! ^ 1;
      writeFileSync(path, bytes);

      const repaired = keep(await store.build());
      expect(repaired.snapshotId).not.toBe(original.snapshotId);
      expect(repaired.manifest.sourceFingerprint).toBe(
        original.manifest.sourceFingerprint,
      );
      const latest = keep(store.openLatest());
      expect(latest.snapshotId).toBe(repaired.snapshotId);
      await expect(latest.verify()).resolves.toBeUndefined();
      expect(latest.sliceSymbol(stock).volume[0]).toBe(100003);
    },
  );
  it("扫描和单标默认仍限原证券域，显式读取 ETF 日线及 lc5 的全量、尾窗和日期窗", async () => {
    const b = Buffer.alloc(64);
    for (let i = 0; i < 2; i++) {
      const at = i * 32;
      b.writeUInt16LE((2026 - 2004) * 2048 + 101, at);
      b.writeUInt16LE(575 + i * 5, at + 2);
      [1.234, 1.239, 1.231, 1.237, 510.25].forEach((v, j) =>
        b.writeFloatLE(v, at + 4 + j * 4),
      );
      b.writeUInt32LE(1004 + i, at + 24);
    }
    source("vipdoc/sh/fzline/" + etf + ".lc5", b);
    expect((await scan(root)).securities.some((s) => s.symbol === etf)).toBe(
      false,
    );
    expect(
      (await scan(root, { includeFunds: true })).securities.filter(
        (s) => s.symbol === etf,
      ),
    ).toHaveLength(2);
    for (const period of ["day", "5m"] as const) {
      await expect(readSnapshot(root, etf, period)).rejects.toThrow();
      await expect(readTailSnapshot(root, etf, period, 2)).rejects.toThrow();
      await expect(localBars(root, etf, period)).rejects.toThrow();
      const snapshot = await readSnapshot(root, etf, period, {
        allowFunds: true,
      });
      expect(
        (await readTailSnapshot(root, etf, period, 2, { allowFunds: true }))
          .bars,
      ).toEqual(snapshot.bars.slice(-2));
      const bounds = { from: snapshot.bars[0]!.date.slice(0, 10) };
      expect(
        (
          await readResearchWindow(root, etf, period, {
            ...bounds,
            allowFunds: true,
          })
        ).bars,
      ).toEqual(snapshot.bars);
      expect(
        (
          await readWindowSnapshot(root, etf, period, {
            ...bounds,
            chartFunds: true,
          })
        ).bars,
      ).toEqual(snapshot.bars);
      expect((await localBars(root, etf, period, true, bounds)).bars).toEqual(
        snapshot.bars,
      );
    }
    vi.stubEnv("QUANT_DATA_DIR", join(root, "..cache"));
    await expect(localBars(root, etf, "day", true)).rejects.toThrow(/只读目录/);
    expect(existsSync(join(root, "..cache"))).toBe(false);
  });
});
