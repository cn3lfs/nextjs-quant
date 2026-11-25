import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settingsSchema } from "~/lib/domain";
import { SCREENER_STRATEGY_KEYS } from "~/lib/research/diagnose-contract";
import { createAlertContext } from "~/server/alerts/inputs/context";
import { evaluateStrategyInputs } from "~/server/alerts/inputs/strategy-signals";
import { put } from "~/server/db";
import { AlertRepository } from "~/server/db/alert-repository";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { saveSettings } from "~/server/infra/settings";
import * as paperActions from "~/server/market/bar-store/corporate-actions";
import { advancePaper } from "~/server/paper/advance";
import { capturePaperDecisions } from "~/server/paper/decisions";
import { loadPaperInput } from "~/server/paper/inputs";
import {
  promoteResearchToPaper,
  watchResearchInShadow,
} from "~/server/paper/promote-from-research";
import { buildStrategy } from "~/server/research/diagnose/strategy-specs";

const initial = 200_000;
const symbols = ["sh600000", "sh600519"];
const startedAt = Date.parse("2026-03-05T00:00:00Z");
const turtleKey = "screener:f04-turtle-donchian";
let db: Database.Database;
let paper: PaperRepository;
let alerts: AlertRepository;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  paper = new PaperRepository(db);
  alerts = new AlertRepository(db);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function tradingDates(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(Date.UTC(2026, 2, 5 - 44 + index));
    return day.getUTCDay() % 6 ? day.toISOString().slice(0, 10) : null;
  }).filter((date) => date !== null);
}

function writeTurtleMarket(
  name: string,
  dates: string[],
  closeAt: (date: string) => number,
) {
  const root = join(process.env.QUANT_DATA_DIR!, name);
  const localBars = join(root, "vipdoc", "sh", "lday");
  const localActions = join(root, "T0002", "hq_cache");
  mkdirSync(localBars, { recursive: true });
  mkdirSync(localActions, { recursive: true });
  const daily = Buffer.concat(
    dates.map((date) => {
      const close = closeAt(date);
      const row = Buffer.alloc(32);
      row.writeUInt32LE(Number(date.replaceAll("-", "")), 0);
      row.writeUInt32LE(close, 4);
      row.writeUInt32LE(close + 10, 8);
      row.writeUInt32LE(close - 10, 12);
      row.writeUInt32LE(close, 16);
      row.writeFloatLE(1_000_000, 20);
      row.writeUInt32LE(100_000, 24);
      return row;
    }),
  );
  for (const symbol of ["sh000906", ...symbols])
    writeFileSync(join(localBars, `${symbol}.day`), daily);
  writeFileSync(join(localActions, "gbbq"), Buffer.alloc(4));
  saveSettings(settingsSchema.parse({ tdxRoot: root, calendar: dates }));
}

it("registers uniquely named CN paper accounts with mirrors off and advances completed local bars", async () => {
  const input = { name: "海龟突破", strategyKey: turtleKey, symbols, initial };
  const turtle = promoteResearchToPaper(input, paper, startedAt);
  const vcp = promoteResearchToPaper(
    {
      ...input,
      name: "VCP 收盘",
      strategyKey: "theory-vcp-close",
      symbols: [symbols[0]!],
    },
    paper,
    startedAt,
  );
  for (const account of [turtle, vcp]) {
    expect(paper.account(account.id)).toMatchObject({
      market: "cn-equity",
      currency: "CNY",
      sleeve: "diag",
      initial,
      startedAt,
      mirror: { venue: "off" },
      lastBar: null,
    });
  }
  expect(turtle.candidates[0]?.strategy).toMatchObject({
    id: "paper-screener-f04-turtle-donchian",
    entry: { kind: "theory-screener", methodId: "f04-turtle-donchian" },
    universe: { kind: "symbols", symbols },
    sizing: { kind: "equal", positions: 2 },
  });
  expect(vcp.candidates[0]?.strategy).toMatchObject({
    entry: { kind: "study-rule", strategy: "theory-vcp-close" },
    sizing: { kind: "weight", weight: 1 },
  });
  expect(() => promoteResearchToPaper(input, paper)).toThrow("账户名称已存在");
  expect(() =>
    promoteResearchToPaper({ ...input, name: "同策略另开账户" }, paper),
  ).toThrow("候选策略已登记");
  expect(paper.ids()).toHaveLength(2);
  expect(alerts.watchedStrategies()).toEqual([]);

  const lastDate = "2026-03-05";
  writeTurtleMarket("promotion-tdx", tradingDates(45), (date) =>
    date === lastDate ? 1050 : 1000,
  );
  const now = Date.parse("2026-03-06T00:00:00Z");
  for (const account of [turtle, vcp]) {
    const paperInput = await loadPaperInput(account, now);
    expect(paperInput?.readyDates).toEqual([lastDate]);
    advancePaper(paper, account.id, paperInput!, now);
    expect(paper.account(account.id)?.lastBar).toBe(lastDate);
  }
  expect(paper.state(turtle.id)?.decisions).toEqual(
    symbols.map((symbol) => expect.objectContaining({ symbol, entry: true })),
  );
});

it.each(["holdBars", "signal stop"] as const)(
  "exits a promoted screener on %s after replaying its entry checkpoint",
  async (trigger) => {
    const symbol = symbols[0]!;
    const account = promoteResearchToPaper(
      { name: "海龟退出", strategyKey: turtleKey, symbols: [symbol], initial },
      paper,
      startedAt,
    );
    const exit = account.candidates[0]!.strategy.exit.rule;
    if (exit?.kind !== "theory-screener")
      throw new Error("Missing screener exit");
    const dates = tradingDates(145);
    const firstForward = dates.indexOf("2026-03-05");
    const signalIndex = firstForward;
    const entryIndex = signalIndex + 1;
    const exitIndex =
      entryIndex + (trigger === "signal stop" ? 1 : exit.holdBars!);
    const sellDate = dates[exitIndex + 1]!;
    writeTurtleMarket(`promotion-exit-${trigger}`, dates, (date) => {
      if (date < dates[signalIndex]!) return 1000;
      if (trigger === "signal stop" && date >= dates[exitIndex]!) return 995;
      return 1050;
    });

    const beforeExit = Date.parse(`${dates[entryIndex + 1]}T00:00:00Z`);
    const entry = await loadPaperInput(account, beforeExit);
    expect(entry).not.toBeNull();
    expect(entry?.readyDates[0]).toBe(dates[signalIndex]);
    advancePaper(paper, account.id, entry!, beforeExit);
    const checkpoint = paper.state(account.id)!;
    expect(checkpoint.result.fills).toMatchObject([
      { symbol, date: dates[entryIndex], side: "buy" },
    ]);

    const afterExit = Date.parse(`${dates[exitIndex + 2]}T00:00:00Z`);
    const followUp = await loadPaperInput(
      paper.account(account.id)!,
      afterExit,
    );
    expect(followUp).not.toBeNull();
    advancePaper(paper, account.id, followUp!, afterExit);
    const replayed = paper.state(account.id)!;
    expect(replayed.result.fills).toMatchObject([
      checkpoint.result.fills[0]!,
      { symbol, date: sellDate, side: "sell" },
    ]);
    expect(replayed.events?.[0]).toEqual(checkpoint.events?.[0]);
  },
);

it("captures a first-limit-up entry using each member's board limit", () => {
  const members = ["sh600000", "sz300750", "bj920001"];
  const strategy = buildStrategy(
    "screener:f11-first-limit-up-break",
    members,
    "portfolio",
  );
  const dates = tradingDates(50);
  const date = dates.at(-1)!;
  const capture = (symbol: string, closeAtSignal: number) => {
    const bars = dates.map((day) => ({
      date: day,
      open: 10,
      high: day === date ? closeAtSignal : 10.1,
      low: 9.9,
      close: day === date ? closeAtSignal : 10,
      volume: 100_000,
      amount: 1_000_000,
    }));
    return capturePaperDecisions(
      [strategy],
      { symbol, market: "cn-equity", bars, signalBars: bars, execution: {} },
      [date],
      Date.parse(`${date}T16:00:00+08:00`),
      "fixture",
    );
  };
  for (const [index, symbol] of members.entries()) {
    expect(capture(symbol, 11 + index)).toMatchObject([
      { symbol, entry: true },
    ]);
    expect(capture(symbol, 10 + index)).toMatchObject([
      { symbol, entry: false },
    ]);
  }
});

it("accepts long-capable screener keys that can advance from daily inputs", () => {
  expect(SCREENER_STRATEGY_KEYS).toHaveLength(56);
  for (const strategyKey of SCREENER_STRATEGY_KEYS) {
    if (strategyKey.startsWith("screener:f11-")) continue;
    const account = promoteResearchToPaper(
      { name: strategyKey, strategyKey, symbols, initial },
      paper,
      startedAt,
    );
    expect(account.candidates[0]?.strategy.entry.kind).toBe("theory-screener");
  }
});

it.each(
  SCREENER_STRATEGY_KEYS.filter((key) => key.startsWith("screener:f11-")),
)(
  "requires forward sentiment evidence before paper promotion of %s",
  (strategyKey) => {
    expect(() =>
      promoteResearchToPaper(
        { name: strategyKey, strategyKey, symbols, initial },
        paper,
        startedAt,
      ),
    ).toThrow(/情绪周期门控.*sentimentRegimeSnapshot/);
    expect(paper.ids()).toEqual([]);
  },
);

it("keeps a study-rule paper checkpoint on one signal price scale through a 2-for-1 split", async () => {
  const repo = new PaperRepository();
  const symbol = symbols[0]!;
  const signalDate = "2026-03-05";
  const splitDate = "2026-03-06";
  writeTurtleMarket("promotion-study-split", tradingDates(46), (date) =>
    date < splitDate ? 1000 : 500,
  );
  const actions = vi.spyOn(paperActions, "corporateActions").mockResolvedValue({
    events: new Map(),
    path: "fixture",
    fingerprint: "pre-split",
    modified: 0,
  });
  const account = promoteResearchToPaper(
    {
      name: "VCP 拆股基准",
      strategyKey: "theory-vcp-close",
      symbols: [symbol],
      initial,
    },
    repo,
    startedAt,
  );
  const beforeSplit = Date.parse(`${splitDate}T12:00:00+08:00`);
  const first = (await loadPaperInput(account, beforeSplit))!;
  advancePaper(repo, account.id, first, beforeSplit);
  expect(
    repo.state(account.id)?.request.instruments[0]?.signalBars.at(-1),
  ).toMatchObject({
    date: signalDate,
    close: 10,
  });

  actions.mockResolvedValue({
    events: new Map([
      [symbol, [{ date: splitDate, category: 1, name: "送转", bonusRatio: 1 }]],
    ]),
    path: "fixture",
    fingerprint: "post-split",
    modified: 1,
  });
  const afterSplit = Date.parse("2026-03-07T12:00:00+08:00");
  const next = (await loadPaperInput(repo.account(account.id)!, afterSplit))!;
  expect(next.request.instruments[0]?.bars.at(-1)).toMatchObject({
    date: splitDate,
    close: 5,
  });
  expect(next.request.instruments[0]?.signalBars.at(-1)).toMatchObject({
    date: splitDate,
    close: 10,
  });
  advancePaper(repo, account.id, next, afterSplit);
  expect(
    repo.state(account.id)?.request.instruments[0]?.signalBars.slice(-2),
  ).toMatchObject([
    { date: signalDate, close: 10 },
    { date: splitDate, close: 10 },
  ]);
});

it.each([
  ["research-canslim-pit", "PIT"],
  ["research-chan", "原生缠论"],
  ["core-4", "组合分仓"],
  ["hold", "研究对照"],
  ["screener:f08-wyckoff-utad-sow", "可做多"],
  ["missing-strategy", "不支持的研究策略"],
])(
  "rejects paper promotion of %s before persisting anything",
  (strategyKey, reason) => {
    expect(() =>
      promoteResearchToPaper(
        { name: strategyKey, strategyKey, symbols, initial },
        paper,
      ),
    ).toThrow(reason);
    expect(paper.ids()).toEqual([]);
    expect(alerts.definitions()).toEqual([]);
  },
);

it("registers only shadow state and preserves the observation epoch on re-watch", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
  const input = { strategyKey: turtleKey, symbols };
  const watched = watchResearchInShadow(input, alerts);
  expect(watched).toEqual({
    strategyId: `diag-${turtleKey}`,
    version: 1,
    mode: "shadow",
    symbolCount: 2,
    alreadyWatched: false,
  });
  const id = `${watched.strategyId}:${watched.version}`;
  expect(alerts.watchedStrategies()).toMatchObject([
    { id: watched.strategyId, universe: { kind: "symbols", symbols } },
  ]);
  expect(alerts.state(`shadow:${id}`)).toMatchObject({
    active: true,
    startedAt,
  });
  expect(alerts.state(`strategy:${id}`)).toBeUndefined();
  expect(alerts.state(`universe:${id}`)).toBeUndefined();

  clock.mockReturnValue(startedAt + 86_400_000);
  expect(
    watchResearchInShadow(
      { ...input, symbols: [...symbols].reverse() },
      alerts,
    ),
  ).toEqual({
    ...watched,
    alreadyWatched: true,
  });
  expect(alerts.state(`shadow:${id}`)).toMatchObject({
    active: true,
    startedAt,
  });
  expect(alerts.liveStrategies()).toEqual([]);
  expect(alerts.subscriptions()).toEqual([]);
  expect(alerts.records.all("delivery")).toEqual([]);
});

it("accepts native Chan close signals and persists a supplied universe for a strategy object", () => {
  const thirdBuy = watchResearchInShadow(
    { strategyKey: "research-chan", symbols },
    alerts,
  );
  expect(
    alerts.strategies.strategy(thirdBuy.strategyId, thirdBuy.version)?.entry
      .kind,
  ).toBe("chan-third-buy");

  const native = buildStrategy("research-chan-hold-cash", symbols, "portfolio");
  const strategy = { ...native, universe: { kind: "pool", id: "qa" } };
  const input = { strategy, symbols };
  const watched = watchResearchInShadow(input, alerts);
  const id = `${watched.strategyId}:${watched.version}`;
  expect(alerts.state(`universe:${id}`)).toEqual(symbols);
  expect(
    alerts.strategies.strategy(watched.strategyId, watched.version)?.entry.kind,
  ).toBe("chan-native");
  expect(() =>
    watchResearchInShadow({ ...input, symbols: [symbols[0]!] }, alerts),
  ).toThrow("调整证券池须使用新策略版本");
  expect(alerts.state(`universe:${id}`)).toEqual(symbols);
});

it.each([
  { mode: "shadow", selected: [symbols[0]!] },
  { mode: "live", selected: [symbols[1]!, symbols[0]!] },
])(
  "scans the expected configured and watchlist symbols in $mode mode",
  async ({ mode, selected }) => {
    const symbol = symbols[0]!;
    const watchlistSymbol = symbols[1]!;
    const strategy = {
      ...buildStrategy(turtleKey, [symbol], "single"),
      universe: { kind: "pool" as const, id: "qa" },
    };
    if (mode === "shadow") {
      watchResearchInShadow({ strategy, symbols: [symbol] }, alerts);
    } else {
      const registered = alerts.strategies.saveStrategy(strategy);
      const id = `${registered.id}:${registered.version}`;
      alerts.saveState(`strategy:${id}`, { live: true });
      alerts.saveState(`universe:${id}`, [symbol]);
    }
    put("config", "watchlist", [watchlistSymbol]);
    const ctx = createAlertContext("close", Date.now(), alerts);
    const series = vi.fn<typeof ctx.series>().mockResolvedValue({
      symbol,
      market: "cn-equity",
      bars: [],
      rawBars: [],
      source: "fixture",
      completedAt: () => 0,
    });
    await evaluateStrategyInputs({ ...ctx, series });
    expect(series.mock.calls).toEqual(
      selected.map((item) => [item, "day", true]),
    );
  },
);

it("rejects unsupported shadow inputs and leaves an existing live registration untouched", () => {
  expect(() =>
    watchResearchInShadow(
      { strategyKey: "research-canslim-pit", symbols },
      alerts,
    ),
  ).toThrow("PIT");
  expect(() =>
    watchResearchInShadow(
      { strategyKey: turtleKey, symbols, mode: "live" },
      alerts,
    ),
  ).toThrow();
  expect(() =>
    promoteResearchToPaper(
      {
        name: "镜像",
        strategyKey: turtleKey,
        symbols,
        initial,
        mirror: { venue: "ths" },
      },
      paper,
    ),
  ).toThrow();
  expect(alerts.definitions()).toEqual([]);
  expect(paper.ids()).toEqual([]);

  const strategy = alerts.strategies.saveStrategy(
    buildStrategy(turtleKey, symbols, "portfolio"),
  );
  const id = `${strategy.id}:${strategy.version}`;
  const live = { live: true, revision: "existing" };
  alerts.saveState(`strategy:${id}`, live);
  expect(() => watchResearchInShadow({ strategy }, alerts)).toThrow(
    "已开启实盘提醒",
  );
  expect(alerts.state(`strategy:${id}`)).toEqual(live);
  expect(alerts.state(`shadow:${id}`)).toBeUndefined();
  expect(alerts.subscriptions()).toEqual([]);
  expect(alerts.records.all("delivery")).toEqual([]);
});
