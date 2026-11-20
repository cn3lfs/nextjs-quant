import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { etfNetSubscriptions } from "../../src/server/market/etf-net-subscriptions";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const iso = (offset: number) => {
  const date = new Date(Date.UTC(2026, 8, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

const dayInt = (offset: number) => Number(iso(offset).replaceAll("-", ""));

const CSV_HEADER =
  "date,合计_state,合计_score,合计_f1_yi,核心池_state,核心池_score,核心池_f1_yi";

function csvRow(
  date: string,
  net: number | "",
  coreNet: number | "" = "",
  state = "托底期",
  score: number | "" = 50,
) {
  return `${date},${state},${score},${net},${state},${score},${coreNet}`;
}

/** 32-byte TDX daily bar: date, OHLC (fen), amount, volume. */
function tdxBar(date: number, close: number) {
  const bytes = Buffer.alloc(32);
  const price = Math.round(close * 100);
  bytes.writeUInt32LE(date, 0);
  for (const offset of [4, 8, 12, 16]) bytes.writeUInt32LE(price, offset);
  bytes.writeFloatLE(1e8, 20);
  bytes.writeUInt32LE(1000, 24);
  return bytes;
}

async function createDirs({
  rows,
  csvBars,
  tdxBars,
}: {
  rows: string[];
  csvBars?: { date: string; close: number }[];
  tdxBars?: Buffer[];
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "quant-nt-etf-"));
  const tdxDir = await mkdtemp(join(tmpdir(), "quant-nt-tdx-"));
  roots.push(dataDir, tdxDir);
  await writeFile(
    join(dataDir, "state_history.csv"),
    [CSV_HEADER, ...rows].join("\n"),
    "utf8",
  );
  if (csvBars) {
    await mkdir(join(dataDir, "kline"), { recursive: true });
    await writeFile(
      join(dataDir, "kline", "sh000001.csv"),
      [
        "date,open,close,high,low,volume,amount",
        ...csvBars.map(
          (b) =>
            `${b.date},${b.close},${b.close},${b.close},${b.close},100,100`,
        ),
      ].join("\n"),
      "utf8",
    );
  }
  if (tdxBars) {
    await mkdir(join(tdxDir, "vipdoc/sh/lday"), { recursive: true });
    await writeFile(
      join(tdxDir, "vipdoc/sh/lday/sh000001.day"),
      Buffer.concat(tdxBars),
    );
  }
  return { dataDir, tdxDir };
}

describe("国家队指标本地宽基 ETF 日度净申赎", () => {
  it("按北京时间截止并跳过前导空行，最多取最近 60 个记录日，源覆盖不被截断", async () => {
    const rows: string[] = [
      csvRow("2010-01-04", "", "", "", ""),
      csvRow("2010-01-05", "", "", "", ""),
    ];
    for (let index = 0; index < 65; index++)
      rows.push(csvRow(iso(index), index + 0.5, index + 0.25, "企稳确认", 30));
    // 截止日之后的记录不参与当前窗口，但计入源整体有效范围。
    rows.push(csvRow(iso(80), 888, 500, "托底期", 80));

    const { dataDir, tdxDir } = await createDirs({ rows });
    const data = await etfNetSubscriptions(tdxDir, iso(64), dataDir);

    expect(data.state).toBe("ok");
    expect(data.source).toBe("国家队指标");
    expect(data.requestedDate).toBe(iso(64));
    expect(data.points).toHaveLength(60);
    expect(data.window).toEqual({ start: iso(5), end: iso(64), count: 60 });
    expect(data.latest).toBe(iso(64));
    expect(data.points.at(-1)).toEqual({
      date: iso(64),
      net: 64.5,
      coreNet: 64.25,
      regime: "企稳确认",
      score: 30,
      index: null,
    });
    expect(data.points.every((point) => point.date <= iso(64))).toBe(true);
    expect(data.sourceFirst).toBe(iso(0));
    expect(data.sourceLast).toBe(iso(80));
  });

  it("缺失不补零、同日重复按歧义缺失报告，真实 0 与负数有效", async () => {
    const { dataDir } = await createDirs({
      rows: [
        csvRow(iso(0), 12.5, 8.1, "托底期", 45),
        csvRow(iso(1), 0, 0, "观望", 0),
        csvRow(iso(2), -8.25, -4.5, "撤退期", -35),
        csvRow(iso(3), 3, 2),
        csvRow(iso(3), 99, 50),
        csvRow(iso(4), "", "", "观望", ""),
        csvRow(iso(5), 4, 2.2, "企稳确认", 18),
      ],
    });

    const data = await etfNetSubscriptions("", iso(5), dataDir);

    expect(data.points.map((point) => point.date)).toEqual([
      iso(0),
      iso(1),
      iso(2),
      iso(3),
      iso(4),
      iso(5),
    ]);
    expect(data.points.map((point) => point.net)).toEqual([
      12.5,
      0,
      -8.25,
      null,
      null,
      4,
    ]);
    expect(data.duplicates).toEqual([{ date: iso(3), count: 2 }]);
    expect(data.summary).toEqual({
      total: null,
      coreTotal: null,
      valid: 4,
      complete: false,
    });
  });

  it("仅 60 个记录日全部有效才给出区间合计与核心池合计", async () => {
    const completeRows: string[] = [];
    for (let index = 0; index < 60; index++)
      completeRows.push(csvRow(iso(index), 1.5, 0.75));
    const complete = await createDirs({ rows: completeRows });
    const completeData = await etfNetSubscriptions(
      "",
      iso(59),
      complete.dataDir,
    );
    expect(completeData.summary.complete).toBe(true);
    expect(completeData.summary.valid).toBe(60);
    expect(completeData.summary.total).toBeCloseTo(90, 6);
    expect(completeData.summary.coreTotal).toBeCloseTo(45, 6);

    const missingRows = completeRows.map((row, idx) =>
      idx === 10 ? csvRow(iso(idx), "", "") : row,
    );
    const missing = await createDirs({ rows: missingRows });
    const missingData = await etfNetSubscriptions("", iso(59), missing.dataDir);
    expect(missingData.window!.count).toBe(60);
    expect(missingData.summary).toEqual({
      total: null,
      coreTotal: null,
      valid: 59,
      complete: false,
    });
  });

  it("上证指数优先同目录 kline CSV、缺失日期可补充本地通达信日线，且不跨日填补", async () => {
    const { dataDir, tdxDir } = await createDirs({
      rows: [0, 1, 2, 3].map((offset) => csvRow(iso(offset), offset, offset)),
      csvBars: [
        { date: iso(-1), close: 3400 },
        { date: iso(0), close: 3500 },
        { date: iso(9), close: 3600 },
      ],
      tdxBars: [
        tdxBar(dayInt(0), 3501), // CSV 已存在则优先保留 CSV
        tdxBar(dayInt(2), 3520), // CSV 缺这日时由本地通达信补同日
      ],
    });

    const data = await etfNetSubscriptions(tdxDir, iso(3), dataDir);

    expect(data.index).toMatchObject({
      state: "ok",
      matched: 2,
      sourceLast: iso(9),
      warning: null,
    });
    expect(data.points.map((p) => ({ date: p.date, index: p.index }))).toEqual([
      { date: iso(0), index: 3500 },
      { date: iso(1), index: null },
      { date: iso(2), index: 3520 },
      { date: iso(3), index: null },
    ]);
  });

  it("指数读取失败只降级指数，申赎明细与合计照常", async () => {
    const rows: string[] = [];
    for (let index = 0; index < 60; index++)
      rows.push(csvRow(iso(index), 2, 1));
    const { dataDir } = await createDirs({ rows });

    const data = await etfNetSubscriptions("", iso(59), dataDir);

    expect(data.state).toBe("ok");
    expect(data.index).toMatchObject({
      state: "unavailable",
      matched: 0,
      sourceLast: null,
    });
    expect(data.index.warning).toContain("仅显示净申赎");
    expect(data.points.every((point) => point.index === null)).toBe(true);
    expect(data.summary.total).toBeCloseTo(120, 6);
  });

  it("未配置、缺文件、全空历史与截止日早于起点分别可辨识", async () => {
    expect((await etfNetSubscriptions("", iso(0), "")).state).toBe(
      "source-unconfigured",
    );

    const empty = await mkdtemp(join(tmpdir(), "quant-nt-empty-"));
    roots.push(empty);
    const missing = await etfNetSubscriptions("", iso(0), empty);
    expect(missing.state).toBe("no-history");
    expect(missing.points).toEqual([]);

    const blankOnly = await createDirs({
      rows: [csvRow(iso(0), "", "", "", "")],
    });
    expect(
      (await etfNetSubscriptions("", iso(5), blankOnly.dataDir)).state,
    ).toBe("no-history");

    const { dataDir } = await createDirs({ rows: [csvRow(iso(5), 1, 0.5)] });
    const early = await etfNetSubscriptions("", iso(4), dataDir);
    expect(early.state).toBe("no-history");
    expect(early.sourceFirst).toBe(iso(5));
    expect(early.sourceLast).toBe(iso(5));
    expect(early.points).toEqual([]);
  });
});
