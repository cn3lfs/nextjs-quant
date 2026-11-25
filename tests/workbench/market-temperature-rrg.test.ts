import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { marketRouter } from "~/server/api/routers/market";
import { saveSettings, settings } from "~/server/infra/settings";
import { MarketPanelStore } from "~/server/market/market-panel";
import { getMarketPanelStatus } from "~/server/market/market-panel-job";
import {
  calculateIndustryRotation,
  industryRotationRrg,
  rrgQuadrant,
} from "~/server/market/industry-rotation";
import {
  marketTemperature,
  scoreTemperature,
} from "~/server/market/market-temperature";
import type { TemperatureSession } from "~/server/market/market-temperature-inputs";
import { CORE_30_V1_PRESET } from "~/server/research/diagnose/universe-presets";
import { workspaceNews } from "~/server/news/intel-service";

function weekdays(n: number) {
  const dates: string[] = [];
  for (let i = 0; dates.length < n; i++) {
    const d = new Date(Date.UTC(2024, 0, 1 + i));
    if (d.getUTCDay() && d.getUTCDay() !== 6)
      dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
function raw(date: string, n: number): TemperatureSession {
  return {
    date,
    complete: true,
    breadth: n / 1000,
    trend: n / 1000,
    limitUp: n,
    highestStreak: n,
    turnoverCny: n,
    etfNet5Yi: n,
    advancing: n,
    breadthSample: 1000,
    aboveTrend: n,
    trendSample: 1000,
    turnoverSample: 1000,
  };
}
it("uses exactly [t-251,t], requires 120 valid paired observations, and cannot see a changed future suffix", () => {
  const rows = weekdays(300).map((date, i) => raw(date, i * 2));
  rows[30]!.highestStreak = null;
  rows[252] = raw(rows[252]!.date, 1);
  const curve = scoreTemperature(rows);
  expect(curve[118]!.score).toBeNull();
  expect(curve[119]!.dimensions.breadth).toMatchObject({
    score: 100,
    samples: 120,
  });
  expect(curve[119]!.dimensions.limits).toMatchObject({
    count: { samples: 119 },
    score: null,
  });
  expect(curve[120]!.dimensions.limits.score).toBe(100);
  // The 0 on session 0 just expired. All other earlier values are >=2.
  expect(curve[252]!.dimensions.turnover).toEqual({
    raw: 1,
    samples: 252,
    score: 0,
  });
  const changed = rows.map((r, i) => (i <= 252 ? r : raw(r.date, 999)));
  expect(scoreTemperature(changed).slice(0, 253)).toEqual(curve.slice(0, 253));
});

it("hand-calculates ties, both limit inputs and missing-weight normalization", () => {
  const rows: TemperatureSession[] = weekdays(120).map((date, i) => ({
    ...raw(date, i),
    trend: 1 - i / 120,
    turnoverCny: 120 - i,
    highestStreak: 3,
    etfNet5Yi: 0,
  }));
  const last = () => scoreTemperature(rows).at(-1)!;
  // Breadth 100, trend 0, limits (100+50)/2, turnover 0, ETF 50.
  expect(last()).toMatchObject({
    score: 45,
    coverageWeight: 100,
    dimensions: { etf: { raw: 0, score: 50 } },
  });
  rows[119]!.etfNet5Yi = null;
  rows[119]!.highestStreak = null;
  expect(last().coverageWeight).toBe(70);
  expect(last().score).toBeCloseTo(2500 / 70);
  rows[119]!.breadth = null;
  expect(last()).toMatchObject({
    score: null,
    regime: null,
    coverageWeight: 45,
  });
});

it("requires two middle-band closes after each gap and treats the 35/65 boundaries as extremes", () => {
  const rows = weekdays(140).map((date) => raw(date, 50));
  rows[121] = raw(rows[121]!.date, 100);
  rows[123]!.complete = false;
  rows[126] = raw(rows[126]!.date, 0);
  const points = scoreTemperature(rows);
  expect(points.slice(119, 128).map((p) => [p.regime, p.middleStreak])).toEqual(
    [
      [null, 1],
      ["neutral", 2],
      ["offensive", 0],
      ["offensive", 1],
      [null, 0],
      ["offensive", 1],
      ["neutral", 2],
      ["defensive", 0],
      ["defensive", 1],
    ],
  );
  // A Tuesday with no session/closure evidence must break Monday's confirmation.
  const missing = scoreTemperature(rows.filter((_, i) => i !== 127));
  expect(missing.find((p) => p.date === rows[128]!.date)).toMatchObject({
    regime: "defensive",
    middleStreak: 1,
  });
  // 121 unique observations, rank with exactly 42/120 or 78/120 below.
  for (const [below, threshold, regime] of [
    [42, 35, "defensive"],
    [78, 65, "offensive"],
  ] as const) {
    const ordered = weekdays(121).map((date, i) =>
      raw(date, i < 120 ? 2 * i : 2 * below - 1),
    );
    expect(scoreTemperature(ordered).at(-1)).toMatchObject({
      score: threshold,
      regime,
    });
  }
});

const industrySymbols = Object.values(CORE_30_V1_PRESET.metadata).map(
  (m) => "sh" + m.industryCode,
);
function rotationFixture() {
  const dates = weekdays(150),
    closes = new Map<string, Map<string, number>>();
  closes.set("sh000300", new Map(dates.map((d) => [d, 100])));
  const endings = [
    [10, 12],
    [13, 12],
    [10, 8],
    [7, 8],
  ];
  for (const [k, s] of industrySymbols.entries()) {
    const [a, b] = endings[k % 4]!;
    closes.set(
      s,
      new Map(dates.map((d, i) => [d, i < 140 ? 10 : i < 145 ? a! : b!])),
    );
  }
  return { dates, closes };
}
it("maps all 30 L1 indices, all four quadrants, 100 boundaries, hand-computed smoothing and tied RPS", () => {
  const { dates, closes } = rotationFixture();
  const result = calculateIndustryRotation({
    through: dates[149]!,
    sessions: dates,
    closes,
  });
  expect(result.rows).toHaveLength(30);
  expect(result.weeks).toHaveLength(8);
  expect(result.rows.every((row) => row.trail.length === 8)).toBe(true);
  expect(result.rows.slice(0, 4).map((row) => row.latest!.quadrant)).toEqual([
    "leading",
    "weakening",
    "lagging",
    "improving",
  ]);
  expect(rrgQuadrant(100, 100)).toBe("leading");
  expect(rrgQuadrant(99, 100)).toBe("improving");
  expect(rrgQuadrant(100, 99)).toBe("weakening");
  // RS=12, SMA4=(10+10+10+12)/4; previous two X both 100.
  expect(result.rows[0]!.latest!.relativeClose).toBe(12);
  expect(result.rows[0]!.latest!.x).toBeCloseTo(800 / 7);
  expect(result.rows[0]!.latest!.y).toBeCloseTo(1200 / 11);
  // 16 sectors return +20%, occupying places 1..16 at 20,60,120d.
  for (const horizon of [20, 60, 120] as const) {
    expect(result.rows[0]!.rps[horizon]!.rank).toBe(8.5);
    expect(result.rows[0]!.rps[horizon]!.rps).toBeCloseTo((1 - 8.5 / 30) * 100);
  }
  expect(result.rows[0]!.rps[5]!.return).toBeCloseTo(0.2);
  expect(result.rows[1]!.rps[5]!.return).toBeCloseTo(12 / 13 - 1);
});

it("retains missing ISO weeks, rejects stale/incomplete close pairs and admits a shortened week only with closure evidence", () => {
  const { dates, closes } = rotationFixture();
  const through = dates[144]!,
    symbol = industrySymbols[0]!;
  const run = (sessions = dates, closedDays: string[] = []) =>
    calculateIndustryRotation({ through, sessions, closedDays, closes });
  const prior = run();
  for (const prices of closes.values())
    for (const d of dates.slice(145)) prices.set(d, 9999);
  expect(run()).toEqual(prior);
  expect(
    calculateIndustryRotation({ through: dates[147]!, sessions: dates, closes })
      .weeks,
  ).toEqual(prior.weeks);
  closes.get(symbol)!.delete(dates[138]!); // Thursday is not the weekly endpoint.
  expect(run().rows[0]!.trail.at(-2)?.closeDate).toBe(dates[139]);
  closes.get(symbol)!.delete(dates[139]!); // Missing industry close on Friday.
  expect(run().rows[0]!.trail.at(-2)).toMatchObject({
    closeDate: null,
    x: null,
    y: null,
  });
  expect(run().rows[0]!.latest!.y).toBeNull();
  const noFriday = dates.filter((d) => d !== through);
  const benchmark = closes.get("sh000300")!;
  const lastIndustryClose = closes.get(symbol)!.get(through)!;
  closes.get(symbol)!.delete(through);
  expect(run(noFriday).weeks.at(-1)!.closeDate).toBe(through);
  expect(run(noFriday).rows[0]!.latest!.closeDate).toBeNull();
  closes.get(symbol)!.set(through, lastIndustryClose);
  benchmark.delete(through);
  expect(run(noFriday).weeks.at(-1)!.closeDate).toBeNull();
  expect(run(noFriday, [through]).weeks.at(-1)!.closeDate).toBe(dates[143]);
  benchmark.set(through, 100);
  const holiday = dates.slice(125, 130);
  for (const day of holiday) benchmark.delete(day);
  const gap = run(
    dates.filter((d) => !holiday.includes(d)),
    holiday,
  );
  expect(gap.weeks).toHaveLength(8);
  expect(gap.weeks.find((w) => w.end === holiday.at(-1))?.closeDate).toBeNull();
  benchmark.delete(through);
  expect(run().rows[1]!.latest).toMatchObject({
    relativeClose: null,
    quadrant: null,
  });
});

let fixture: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  if (fixture) {
    rmSync(fixture, { recursive: true, force: true });
    fixture = undefined;
  }
});
it("matches exact codes and normalized names before limiting news and merges source labels", () => {
  fixture = mkdtempSync(join(process.env.QUANT_DATA_DIR!, "workspace-news-"));
  const path = join(fixture, "cls.sqlite");
  const db = new Database(path);
  const now = Date.parse("2026-11-24T16:00:00+08:00");
  try {
    db.exec(
      "CREATE TABLE news(id INTEGER PRIMARY KEY,ctime INTEGER,collected_at TEXT,title TEXT,content TEXT,shareurl TEXT)",
    );
    const insert = db.prepare("INSERT INTO news VALUES(?,?,NULL,?,?,NULL)");
    [
      ["贵州茅台披露公告", ""],
      ["股票代码６００５１９．ＳＨ", ""],
      ["成交额600519万元，编号1600519", ""],
      ["其他股票（600519.SZ）", ""],
      ["行业快讯", "原文".repeat(550) + "宁德时代发布公告"],
      ["A+B 发布公告", ""],
    ].forEach(([title, content], i) =>
      insert.run(i + 1, now / 1000 - 1, title, content),
    );
  } finally {
    db.close();
  }
  const before = snapshot(fixture);
  const result = workspaceNews(
    {
      holdings: [{ symbol: "sh600519", name: "贵州茅台" }],
      watchlist: [{ symbol: "600519.SH" }],
      candidates: [{ symbol: "sz300750", name: "宁德时代" }],
      limit: 2,
    },
    path,
    now,
  );
  expect(
    result.items.map(({ id, matches }) => [
      id,
      matches.map((m) => m.sourceLabels),
    ]),
  ).toEqual([
    ["5", [["候选"]]],
    ["2", [["持仓", "自选"]]],
  ]);
  expect(
    workspaceNews(
      { holdings: [{ symbol: "sz000001", name: "A+B" }] },
      path,
      now,
    ).items.map(({ id }) => id),
  ).toEqual(["6"]);
  expect(snapshot(fixture)).toEqual(before);
});
it("caps sparse workspace news scans at the 2000 newest rows in the requested window", () => {
  fixture = mkdtempSync(join(process.env.QUANT_DATA_DIR!, "workspace-sparse-"));
  const path = join(fixture, "cls.sqlite");
  const db = new Database(path);
  const now = Date.parse("2026-11-24T16:00:00+08:00");
  const second = now / 1000;
  try {
    db.exec(`
      CREATE TABLE news(id INTEGER PRIMARY KEY,ctime INTEGER,collected_at TEXT,title TEXT,content TEXT,shareurl TEXT);
      CREATE INDEX news_time_id ON news(ctime DESC,id DESC);
    `);
    const insert = db.prepare("INSERT INTO news VALUES(?,?,NULL,?,'',NULL)");
    db.transaction(() => {
      insert.run(1, second - 2001, "窗口内但超出扫描预算：贵州茅台");
      for (let i = 2; i <= 2001; i++)
        insert.run(i, second - 2002 + i, i === 2 ? "贵州茅台" : "无关新闻");
      insert.run(2002, second + 1, "未来新闻：贵州茅台");
      insert.run(2003, second - 86401, "窗口外：贵州茅台");
    })();
  } finally {
    db.close();
  }
  const result = workspaceNews(
    { watchlist: [{ symbol: "sh600519", name: "贵州茅台" }], lookbackDays: 1 },
    path,
    now,
  );
  expect(result.items.map(({ id }) => id)).toEqual(["2"]);
});
function source(path: string, bytes: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
function snapshot(dir: string): unknown[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const p = join(dir, e.name);
      return e.isDirectory()
        ? [e.name, snapshot(p)]
        : [
            e.name,
            statSync(p).mtimeMs,
            createHash("sha256").update(readFileSync(p)).digest("hex"),
          ];
    });
}
it("serves both queries from pinned read-only files, preserves gaps and never builds, writes a business DB or connects", async () => {
  fixture = mkdtempSync(join(process.env.QUANT_DATA_DIR!, "temperature-rrg-"));
  const root = join(fixture, "tdx"),
    data = join(fixture, "data"),
    etf = join(fixture, "etf");
  saveSettings({ ...settings(), tdxRoot: root });
  vi.stubEnv("TDX_ROOT", root);
  vi.stubEnv("QUANT_DATA_DIR", data);
  vi.stubEnv("QUANT_NATIONAL_TEAM_DATA_DIR", etf);
  const dates = weekdays(190),
    last = dates.at(-1)!;
  for (const symbol of [
    "sh000001",
    "sh000300",
    "sh881001",
    "sh600000",
    "sz000001",
    "sh510300",
  ]) {
    const bytes = Buffer.alloc(dates.length * 32);
    dates.forEach((d, i) => {
      const at = i * 32,
        value = symbol === "sz000001" ? 2000 : 1000 + i;
      bytes.writeUInt32LE(Number(d.replaceAll("-", "")), at);
      for (let k = 1; k <= 4; k++) bytes.writeUInt32LE(value, at + 4 * k);
      bytes.writeFloatLE(
        symbol.startsWith("sh6") ? 400 : symbol === "sz000001" ? 600 : 10000,
        at + 20,
      );
      bytes.writeUInt32LE(100, at + 24);
    });
    source(
      join(root, "vipdoc", symbol.slice(0, 2), "lday", symbol + ".day"),
      bytes,
    );
  }
  source(join(root, "T0002/hq_cache/gbbq"), Buffer.alloc(4));
  for (const [file, content] of Object.entries({
    "tdxzs.cfg": "A|881001|12|||A",
    "tdxzs3.cfg": "A|881001|12|||A",
    "tdxhy.cfg": "1|600000||||A\n0|000001||||A",
    "spblock.dat": "#x\n1600000",
    "infoharbor_block.dat": "#ZS_x,1,000300,,0\n1#600000",
  }))
    source(join(root, "T0002/hq_cache", file), content);
  const records: Buffer[] = [];
  for (const [i, d] of dates.entries())
    for (const [g, v] of [[24, 10], [30, 3], ...(i === 182 ? [[30, 4]] : [])]) {
      const b = Buffer.alloc(13);
      b[0] = g!;
      b.writeUInt32LE(+d.replaceAll("-", ""), 1);
      b.writeFloatLE(v!, 5);
      records.push(b);
    }
  source(join(root, "vipdoc/cw/gpsh999999.dat"), Buffer.concat(records));
  source(
    join(etf, "state_history.csv"),
    [
      "date,合计_f1_yi",
      ...dates.map((d, i) => d + "," + (i === 180 ? "" : i % 5)),
    ].join("\n"),
  );
  const handle = await new MarketPanelStore(root).build();
  const id = handle.snapshotId;
  const symbolsCount = handle.manifest.symbols.length;
  handle.close();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(last + "T16:00:00+08:00"));
  const before = snapshot(fixture);
  const network = vi.fn(() => {
    throw new Error("network");
  });
  vi.stubGlobal("fetch", network);
  const socket = vi
    .spyOn(Socket.prototype, "connect")
    .mockImplementation(() => {
      throw new Error("network");
    });
  const build = vi
    .spyOn(MarketPanelStore.prototype, "build")
    .mockRejectedValue(new Error("unexpected panel build"));
  expect(getMarketPanelStatus(root)).toEqual({
    ready: true,
    snapshotId: id,
    lastDate: last,
    symbolsCount,
    job: null,
  });
  const query = { snapshotId: id, asOf: last };
  const t = await marketTemperature(query);
  expect(t.latest).toMatchObject({
    date: last,
    coverageWeight: 100,
    sample: { breadth: 2, advancing: 1, trend: 2, aboveTrend: 1, turnover: 2 },
    dimensions: {
      breadth: { raw: 0.5 },
      trend: { raw: 0.5 },
      turnover: { raw: 1000 },
      limits: { count: { raw: 10 }, height: { raw: 3 } },
      etf: { raw: 10 },
    },
  });
  expect(t.advisoryOnly).toBe(true);
  expect(t.history[58]!.dimensions.trend.raw).toBeNull();
  expect(t.history[59]!.dimensions.trend.raw).toBe(0.5);
  expect(t.history.slice(180, 185).map((p) => p.dimensions.etf.raw)).toEqual([
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(t.history[182]!.dimensions.limits.score).toBeNull();
  const rotation = await industryRotationRrg(query);
  expect(rotation.rows).toHaveLength(30);
  expect(rotation.rows[0]!.leaders?.map((r) => r.symbol)).toEqual([
    "sh600000",
    "sz000001",
  ]);
  expect(rotation.rows[0]!.rps[120]!.return).toBeCloseTo(1189 / 1069 - 1);
  expect(rotation.rows[1]!.latest?.quadrant).toBeNull();
  const historical = await industryRotationRrg({ ...query, asOf: dates[100] });
  expect(historical.rows[0]!.leaders).toBeNull();
  vi.setSystemTime(new Date(last + "T11:00:00+08:00"));
  expect((await marketTemperature(query)).latest).toMatchObject({
    complete: false,
    score: null,
    regime: null,
  });
  expect((await industryRotationRrg(query)).weeks.at(-1)!.end).toBe(dates[184]);
  const caller = marketRouter.createCaller({ headers: new Headers() });
  vi.stubEnv("TDX_ROOT", join(fixture, "wrong-root"));
  expect((await caller.marketTemperature(query)).provenance).toMatchObject({
    root,
    snapshotId: id,
  });
  expect((await caller.industryRotationRrg(query)).provenance).toMatchObject({
    root,
    snapshotId: id,
  });
  expect(snapshot(fixture)).toEqual(before);

  vi.stubEnv("TDX_ROOT", root);
  const absentData = join(fixture, "absent-data");
  const missingPointerData = join(fixture, "missing-pointer-data");
  mkdirSync(join(missingPointerData, "market-panel"), { recursive: true });
  const beforeMissing = snapshot(fixture);
  for (const panelData of [absentData, missingPointerData]) {
    vi.stubEnv("QUANT_DATA_DIR", panelData);
    expect(getMarketPanelStatus(root)).toEqual({
      ready: false,
      snapshotId: null,
      lastDate: null,
      symbolsCount: null,
      job: null,
    });
    for (const read of [marketTemperature, industryRotationRrg]) {
      const { provenance } = await read();
      expect(provenance.snapshotId).toBeNull();
      const warnings = provenance.warnings.join("\n");
      expect(warnings).toContain("本地冻结行情面板尚未生成");
      expect(warnings).not.toMatch(/\bENOENT\b|current\.json/i);
      expect(warnings.replaceAll("\\", "/")).not.toContain(
        fixture.replaceAll("\\", "/"),
      );
    }
  }
  expect(existsSync(absentData)).toBe(false);
  expect(snapshot(fixture)).toEqual(beforeMissing);
  expect(build).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect(socket).not.toHaveBeenCalled();
});
