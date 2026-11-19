import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  newsFixtureCutoff,
  seedNewsSource,
} from "../helpers/news-workspace-fixture";

const config = (path: string) => ({
  clsDbPath: path,
  clsDbRole: "unspecified" as const,
  clsComplementDbPath: "",
  clsComplementDbRole: "" as const,
});

const state = vi.hoisted(() => ({
  clsDbPath: "",
  positions: [] as { symbol: string; quantity: number }[],
  plans: [] as { symbol: string }[],
  names: {} as Record<string, string>,
  lookups: [] as string[],
}));
vi.mock("../../src/server/portfolio/account-workspace-service", () => ({
  loadAccountBook: async () => ({ positions: state.positions }),
}));
vi.mock("../../src/server/db/alert-repository", () => ({
  AlertRepository: class {
    plans() {
      return state.plans;
    }
  },
}));
vi.mock("../../src/server/market/securities", () => ({
  storedSecurityName: (symbol: string) => {
    state.lookups.push(symbol);
    return state.names[symbol];
  },
}));
vi.mock("../../src/server/infra/settings", () => ({
  settings: () => ({ clsDbPath: state.clsDbPath }),
}));

import {
  relatedNewsEvents,
  newsWorkspaceDetail,
} from "../../src/server/db/news-workspace-query";
import { intelEvents, todayIntel } from "../../src/server/news/intel-service";

const cleanups: (() => void)[] = [];
beforeEach(() => {
  state.lookups.length = 0;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Row = {
  id: number;
  ctime: number;
  title: string;
  content: string;
};
function fixture(rows: Row[]) {
  const dir = mkdtempSync(join(tmpdir(), "quant-intel-matches-")),
    path = join(dir, "source.sqlite"),
    db = new Database(path);
  db.exec(
    "CREATE TABLE news(id INTEGER PRIMARY KEY,ctime INTEGER,collected_at TEXT,title TEXT,content TEXT,shareurl TEXT)",
  );
  const insert = db.prepare("INSERT INTO news VALUES(?,?,?,?,?,?)");
  db.transaction(() => {
    for (const row of rows)
      insert.run(
        row.id,
        row.ctime,
        "2025-01-07 15:59:30",
        row.title,
        row.content,
        `https://www.cls.cn/detail/${row.id}`,
      );
  })();
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  state.clsDbPath = path;
  return { path, db };
}
const at = (time: string) => Date.parse(`2025-01-07T${time}+08:00`) / 1000;
const now = Date.parse("2025-01-07T16:05:00+08:00"),
  from = Date.parse("2025-01-07T00:00:00+08:00");

it("maps literal SQLite matches to deduplicated held/open-plan securities", async () => {
  const { path } = fixture([
    {
      id: 1,
      ctime: at("15:59:00"),
      title: "多标的消息",
      content:
        "sh600000 浦发银行与 600519 贵州茅台同时被提及；另有 600999 待核验；sh600888 与 600888 为同一只。",
    },
    {
      id: 2,
      ctime: at("15:58:00"),
      title: "长文尾部",
      content: "无关前缀".repeat(260) + "贵州茅台",
    },
    {
      id: 3,
      ctime: at("15:57:00"),
      title: "数字货币",
      content: "btc 行情波动",
    },
    {
      id: 4,
      ctime: at("15:56:00"),
      title: "无关新闻",
      content: "完全无关的内容",
    },
    {
      id: 5,
      ctime: at("15:55:00"),
      title: "大小写样例",
      content: "STRASSE",
    },
    {
      id: 6,
      ctime: at("15:54:00"),
      title: "别名交错",
      content: "丙公司与乙公司分别被提及",
    },
  ]);
  state.positions = [
    { symbol: "sh600000", quantity: 100 },
    { symbol: "sh600519", quantity: 200 },
    { symbol: "BTCUSDT", quantity: 0.5 },
    { symbol: "sh600888", quantity: 300 },
    { symbol: "sh600111", quantity: 400 },
    { symbol: "sh600222", quantity: 500 },
  ];
  state.plans = [
    { symbol: "sh600000" },
    { symbol: "sh600999" },
    { symbol: "sh600888" },
    { symbol: "SH600111" },
  ];
  state.names = {
    sh600000: "浦发银行",
    sh600519: "贵州茅台",
    sh600111: "甲公司",
    sh600222: "丙公司",
    SH600111: "乙公司",
  };

  const result = await todayIntel(now),
    events = result.events;

  expect(events.map((event) => event.id)).toEqual(["1", "2", "3", "6"]);
  expect(events[0]!.matches).toEqual([
    {
      symbol: "sh600000",
      name: "浦发银行",
      sources: ["position", "plan"],
    },
    { symbol: "sh600519", name: "贵州茅台", sources: ["position"] },
    { symbol: "sh600888", name: null, sources: ["position", "plan"] },
    { symbol: "sh600999", name: null, sources: ["plan"] },
  ]);
  expect(events[1]!.matches).toEqual([
    { symbol: "sh600519", name: "贵州茅台", sources: ["position"] },
  ]);
  // The term sits past the 1,000-character preview; SQLite still returned it.
  expect(events[1]!.preview).not.toContain("贵州茅台");
  // ASCII case-insensitive SQLite match, unknown name, one code per target.
  expect(events[2]!.matches).toEqual([
    { symbol: "BTCUSDT", name: null, sources: ["position"] },
  ]);
  expect(events[3]!.matches).toEqual([
    { symbol: "sh600111", name: "甲公司", sources: ["position", "plan"] },
    { symbol: "sh600222", name: "丙公司", sources: ["position"] },
  ]);
  expect(result.symbols).toEqual([
    "sh600000",
    "sh600519",
    "BTCUSDT",
    "sh600888",
    "sh600111",
    "sh600222",
    "sh600999",
    "SH600111",
  ]);
  // Same code with a missing name is looked up once; crypto never looks up a
  // stored name; the plan occurrence reuses the position lookup.
  expect(state.lookups).toEqual([
    "sh600000",
    "sh600519",
    "sh600888",
    "sh600111",
    "sh600222",
    "sh600999",
    "SH600111",
  ]);

  // A/B/a encounter order: B's distinct alias precedes the later a alias in
  // the original term sequence, so the href query must use B's literal term.
  const aliasHref = new URL(events[3]!.href, "http://localhost"),
    aliasFilter = JSON.parse(aliasHref.searchParams.get("newsQuery")!);
  expect(aliasFilter.query).toBe("丙公司");
  expect(
    newsWorkspaceDetail(
      config(path),
      aliasFilter,
      6,
      aliasHref.searchParams.get("newsSource")!,
    ).item.content,
  ).toContain("丙公司与乙公司");

  const href = new URL(events[0]!.href, "http://localhost"),
    filter = JSON.parse(href.searchParams.get("newsQuery")!),
    source = href.searchParams.get("newsSource")!;
  expect(href.pathname).toBe("/intel");
  expect(href.searchParams.get("newsId")).toBe("1");
  expect(filter).toEqual({
    cutoff: Date.parse(events[0]!.publishedAt),
    historical: false,
    query: "sh600000",
  });
  // The existing literal-case original link still opens the exact detail.
  expect(
    newsWorkspaceDetail(config(path), filter, 1, source).item.content,
  ).toContain("浦发银行与 600519 贵州茅台");

  // Preserve the existing case-sensitive detail query: a news item matched only
  // case-insensitively keeps its literal filter and does not open here.
  const btcHref = new URL(events[2]!.href, "http://localhost"),
    btcFilter = JSON.parse(btcHref.searchParams.get("newsQuery")!);
  expect(btcFilter.query).toBe("BTC");
  expect(() =>
    newsWorkspaceDetail(
      config(path),
      btcFilter,
      3,
      btcHref.searchParams.get("newsSource")!,
    ),
  ).toThrow(/范围/);
});

it("uses only SQLite matches and leaves intelEvents unchanged", () => {
  const { path } = fixture([
    {
      id: 1,
      ctime: at("15:59:00"),
      title: "多标的消息",
      content: "sh600000 浦发银行同时被提及",
    },
    {
      id: 2,
      ctime: at("15:58:00"),
      title: "大小写样例",
      content: "STRASSE",
    },
  ]);
  state.names = { sh600000: "浦发银行" };

  // SQLite upper() is ASCII-only; JavaScript toUpperCase() would turn ß into SS,
  // so an empty result proves the JavaScript side does not re-match content.
  expect(relatedNewsEvents(path, ["straße"], from, now)).toEqual([]);
  expect(relatedNewsEvents(path, ["不存在的词"], from, now)).toEqual([]);
  const legacy = relatedNewsEvents(path, ["sh600000"], from, now)[0]!;
  expect(legacy).toMatchObject({ id: "1" });
  expect(legacy).not.toHaveProperty("matches");
  expect(
    relatedNewsEvents(path, ["sh600000"], from, now, true)[0],
  ).toMatchObject({ id: "1", matches: ["sh600000"] });

  const chartEvents = intelEvents({
    symbol: "sh600000",
    from,
    to: now,
  });
  expect(chartEvents.map((event) => event.id)).toEqual(["1"]);
  expect(Object.keys(chartEvents[0]!).sort()).toEqual([
    "href",
    "id",
    "preview",
    "publishedAt",
    "sessionDate",
    "title",
  ]);
  expect(chartEvents[0]!.sessionDate).toBe("2025-01-07");
});

it("keeps the window, descending order and 100-row cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-intel-limit-")),
    path = join(dir, "source.sqlite"),
    db = new Database(path);
  seedNewsSource(db, 121, true);
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const events = relatedNewsEvents(
    path,
    ["合成新闻"],
    newsFixtureCutoff - 7 * 86400000,
    newsFixtureCutoff,
    true,
  );
  expect(events).toHaveLength(100);
  expect(events[0]!.id).toBe("3");
  expect(events[99]!.id).toBe("102");
  expect(events.every((event) => event.matches.includes("合成新闻"))).toBe(
    true,
  );
});
