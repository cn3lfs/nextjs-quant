import { taskEvidence } from "../../src/server/db/task-evidence";
import { taskState } from "../../src/server/db/task-history";
import { formatEvidenceText } from "../../src/lib/common/evidence-text";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { migrate } from "../../src/server/db/migrations";
import { AlertRepository } from "../../src/server/db/alert-repository";
import {
  strategyLabDetail,
  actOnLabStrategy,
  strategyLabPage,
} from "../../src/server/db/strategy-lab";
import { saveValidationScoreboard } from "../../src/server/db/validation-scoreboard";
import {
  backupDatabase,
  databaseStatus,
  saveBackupSettings,
} from "../../src/server/db/backups";
import { dataDirectory, sqlite, put } from "../../src/server/db";
import { relatedNewsEvents } from "../../src/server/db/news-workspace-query";
import { intelEvents } from "../../src/server/news/intel-service";
import { intelChartMarkers } from "../../src/lib/news/intel-events";
import { alertReference } from "../../src/lib/strategy-facts/alert-reference";
import {
  alertKey,
  alertHistorySchema,
  type AlertEvent,
} from "../../src/lib/strategy-facts/alerts";
import { labValidationReport } from "../../src/server/research/lab-report";
import { executeResearchCommand } from "../../src/server/research/research-command";
import { executeLabBacktest } from "../../src/server/research/lab-backtest";
import { settings, saveSettings } from "../../src/server/infra/settings";
import { runPortfolio } from "quant-backtest";
import { strategyObjectSchema } from "trading-strategies";
import { formatNumber } from "trading-strategy-core/format-number";
import type { readBars } from "../../src/server/market/bar-store/read-bars";
import fixture from "../fixtures/tdx-gbbq.json";

afterEach(() => vi.restoreAllMocks());
const strategy = strategyObjectSchema.parse({
  id: "QA-r3c",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: { maxBars: 2 },
  sizing: { kind: "weight", weight: 0.2 },
  sleeve: "swing",
});
function repository() {
  const db = new Database(":memory:");
  migrate(db);
  const repo = new AlertRepository(db);
  repo.strategies.saveStrategy(strategy);
  return repo;
}
function event(bar: string): AlertEvent {
  const identity = {
    strategyId: strategy.id,
    version: 1,
    market: "cn-equity" as const,
    symbol: "sh600000",
    bar,
  };
  return {
    ...identity,
    key: alertKey(identity),
    type: "entry",
    sleeve: "swing",
    price: 10,
    stop: 9,
    target: null,
    observedAt: Date.parse(`${bar}T07:01:00Z`),
    mode: "shadow",
    status: "shadow",
    reason: "QA",
    source: "QA",
    wouldSend: false,
    outcomes: [],
  };
}
describe("R3c manual strategy governance", () => {
  it("keeps research and live unavailable without evidence; stale or absent confirmations cannot write", () => {
    const repo = repository();
    try {
      const d = strategyLabDetail(strategy.id, 1, repo);
      expect(d.eligible).toBe(false);
      expect(() =>
        actOnLabStrategy(
          {
            id: strategy.id,
            version: 1,
            action: "promote",
            confirmed: true,
            revision: d.revision,
          },
          repo,
        ),
      ).toThrow("晋级门槛未通过");
      expect(() =>
        actOnLabStrategy(
          {
            id: strategy.id,
            version: 1,
            action: "live",
            confirmed: true,
            revision: d.revision,
          },
          repo,
        ),
      ).toThrow("先手动晋级");
      expect(() =>
        actOnLabStrategy(
          {
            id: strategy.id,
            version: 1,
            action: "shadow",
            confirmed: false as true,
            revision: d.revision,
          },
          repo,
        ),
      ).toThrow();
      const started = actOnLabStrategy(
        {
          id: strategy.id,
          version: 1,
          action: "shadow",
          confirmed: true,
          revision: d.revision,
        },
        repo,
        1000,
      );
      expect(started.shadow).toMatchObject({ startedAt: 1000, active: true });
      expect(started.live).toBe(false);
      expect(() =>
        actOnLabStrategy(
          {
            id: strategy.id,
            version: 1,
            action: "pause",
            confirmed: true,
            revision: d.revision,
          },
          repo,
        ),
      ).toThrow("重新核对");
      expect(repo.records.all("strategy-governance")).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });
  it("requires manual promotion then live, preserves evidence and never subscribes or changes global mode", () => {
    const repo = repository();
    try {
      repo.saveState(`shadow-summary:${strategy.id}:1`, {
        signals: 30,
        days: 60,
        paused: false,
        assessment: {
          eligible: true,
          reasons: [],
          at: 2000,
          recommendation: "QA only",
        },
      });
      let d = strategyLabDetail(strategy.id, 1, repo);
      expect(() =>
        actOnLabStrategy(
          {
            id: strategy.id,
            version: 1,
            action: "live",
            confirmed: true,
            revision: d.revision,
          },
          repo,
        ),
      ).toThrow("先手动晋级");
      d = actOnLabStrategy(
        {
          id: strategy.id,
          version: 1,
          action: "promote",
          confirmed: true,
          revision: d.revision,
        },
        repo,
        2001,
      );
      expect(d.live).toBe(false);
      d = actOnLabStrategy(
        {
          id: strategy.id,
          version: 1,
          action: "live",
          confirmed: true,
          revision: d.revision,
        },
        repo,
        2002,
      );
      expect(d.live).toBe(true);
      expect(d.forward?.signals).toBe(30);
      expect(repo.subscriptions()).toEqual([]);
      expect(repo.records.read("settings")).toBeUndefined();
      repo.strategies.saveStrategy({ ...strategy, version: 2 });
      expect(strategyLabDetail(strategy.id, 2, repo).eligible).toBe(false);
      expect(
        strategyLabPage({ market: "cn-equity" }, repo).items.map((r) => [
          r.version,
          r.status,
        ]),
      ).toEqual([
        [2, "research"],
        [1, "promoted"],
      ]);
    } finally {
      repo.db.close();
    }
  });
  it("publishing a scoreboard never silently starts or ends observation", () => {
    const repo = new AlertRepository();
    repo.strategies.saveStrategy(strategy);
    saveValidationScoreboard({
      market: "cn-equity",
      inputHash: "QA",
      resultHash: "QA",
      buildHash: "QA",
      rows: [],
      missing: [],
      createdAt: 1,
      runtimeMs: 0,
      universe: "QA",
      gaps: [],
      trialSharpes: [],
    });
    expect(repo.state(`shadow:${strategy.id}:1`)).toBeUndefined();
    repo.saveState(`shadow:${strategy.id}:1`, { active: true, startedAt: 100 });
    saveValidationScoreboard({
      market: "cn-equity",
      inputHash: "QA",
      resultHash: "QA",
      buildHash: "QA",
      rows: [],
      missing: [],
      createdAt: 2,
      runtimeMs: 0,
      universe: "QA",
      gaps: [],
      trialSharpes: [],
    });
    expect(repo.state(`shadow:${strategy.id}:1`)).toEqual({
      active: true,
      startedAt: 100,
    });
  });
});
describe("R3c source references and local Intel", () => {
  it("renders readable reminder identity and filters exact keys rather than a shared strategy/date", () => {
    const repo = repository();
    try {
      const first = event("2026-01-02"),
        second = event("2026-01-05");
      repo.record(strategy, first);
      repo.record(strategy, second);
      expect(alertReference(first, "均线策略").label).toBe(
        "均线策略 · sh600000 · 2026-01-02 · 入场候选",
      );
      expect(alertReference(first).label).not.toContain("[");
      const readable = formatEvidenceText({
        strategyId: strategy.id,
        alertKey: first.key,
        price: 10,
        evidence: ["QA"],
      });
      expect(readable).toContain("策略：QA-r3c");
      expect(readable).toContain("品种 sh600000");
      expect(readable).not.toContain(first.key);
      expect(formatEvidenceText({ key: "monthly-return" })).toContain(
        "monthly-return",
      );
      expect(
        new URL(alertReference(first).href, "http://local").searchParams.get(
          "event",
        ),
      ).toBe(first.key);
      expect(
        repo
          .history(alertHistorySchema.parse({ key: first.key }))
          .items.map((e) => e.key),
      ).toEqual([first.key]);
    } finally {
      repo.db.close();
    }
  });
  it("queries only the existing source, uses exact time bounds, keeps original links and makes no network request", async () => {
    const path = join(dataDirectory(), "intel-qa.sqlite"),
      db = new Database(path);
    db.exec(
      "CREATE TABLE news(id INTEGER PRIMARY KEY,ctime INTEGER,collected_at TEXT,title TEXT,content TEXT,shareurl TEXT)",
    );
    const time = Date.parse("2026-01-05T02:00:00Z");
    db.prepare("INSERT INTO news VALUES(1,?,?,?,?,?)").run(
      time / 1000,
      "2026-01-05 10:01:00",
      "sh600000 公告",
      "QA原文内容",
      "https://example.com/1",
    );
    db.prepare("INSERT INTO news VALUES(2,?,?,?,?,?)").run(
      time / 1000 + 1,
      "2026-01-05 10:01:00",
      "无关标题",
      "另一个公司",
      null,
    );
    db.prepare("INSERT INTO news VALUES(3,?,?,?,?,?)").run(
      time / 1000 + 15 * 3600,
      "2026-01-06 01:01:00",
      "sh600000 跨UTC日期公告",
      "仅QA",
      null,
    );
    db.close();
    const before = await readFile(path),
      fetch = vi.spyOn(globalThis, "fetch");
    const result = relatedNewsEvents(path, ["600000"], time, time);
    expect(result.map((e) => e.title)).toEqual(["sh600000 公告"]);
    const link = new URL(result[0]!.href, "http://local");
    expect(link.searchParams.get("newsId")).toBe("1");
    expect(JSON.parse(link.searchParams.get("newsQuery")!).cutoff).toBe(time);
    expect(relatedNewsEvents(path, ["600000"], time + 1, time + 1000)).toEqual(
      [],
    );
    expect(relatedNewsEvents(path, [], time, time)).toEqual([]);
    saveSettings({ ...settings(), clsDbPath: path });
    const night = intelEvents({
      symbol: "sh600000",
      from: time + 15 * 3600000,
      to: time + 15 * 3600000,
    });
    expect(night[0]?.sessionDate).toBe("2026-01-06");
    const dayBars = ["2026-01-05", "2026-01-06"].map((date) => ({
      date,
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 1,
      amount: 10,
    }));
    expect(intelChartMarkers(night, dayBars, "day")[0]?.time).toBe(
      "2026-01-06",
    );
    expect(await readFile(path)).toEqual(before);
    expect(fetch).toHaveBeenCalledTimes(0);
    expect(() =>
      relatedNewsEvents(
        join(dataDirectory(), "missing.sqlite"),
        ["600000"],
        time,
        time,
      ),
    ).toThrow("新闻存档");
  });
  it("does not attach intraday news to a bar before publication", () => {
    const bars = ["10:00:00", "10:05:00"].map((t) => ({
      date: `2026-01-05T${t}+08:00`,
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 1,
      amount: 10,
    }));
    const markers = intelChartMarkers(
      [
        {
          id: "QA",
          title: "新闻",
          publishedAt: "2026-01-05T02:01:00Z",
          preview: "",
          href: "/intel",
        },
      ],
      bars,
      "5m",
    );
    expect(markers).toHaveLength(1);
    // Chart time represents the Shanghai wall-clock label in UTC coordinates.
    expect(markers[0]!.time).toBe(Date.parse("2026-01-05T10:05:00Z") / 1000);
    expect(markers[0]!.id).toBe("intel:QA");
    expect(
      intelChartMarkers(
        [
          {
            id: "QA",
            title: "迟到",
            publishedAt: "2026-01-05T02:06:00Z",
            preview: "",
            href: "/intel",
          },
        ],
        bars,
        "5m",
      ),
    ).toEqual([]);
  });
});
describe("R3c database backup", () => {
  it("copies committed WAL data and prunes only successful owned backups to configured N", async () => {
    put("QA", "backup-qa", { amount: 123.45 });
    const root = join(dataDirectory(), "backups");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "owner-manual.sqlite"), "keep");
    saveBackupSettings({ keep: 2 });
    for (let n = 0; n < 3; n++) {
      put("QA", "backup-qa", { amount: 123.45 + n });
      await backupDatabase();
    }
    const status = await databaseStatus();
    expect(status.version).toBe(18);
    expect(status.keep).toBe(2);
    expect(status.backups).toHaveLength(2);
    expect(status.latest).toBeGreaterThan(0);
    const saved = new Database(status.backups[0]!.path, { readonly: true });
    try {
      expect(
        JSON.parse(
          (
            saved
              .prepare("SELECT payload FROM records WHERE id='backup-qa'")
              .get() as { payload: string }
          ).payload,
        ),
      ).toEqual({ amount: 125.45 });
    } finally {
      saved.close();
    }
    expect(await readFile(join(root, "owner-manual.sqlite"), "utf8")).toBe(
      "keep",
    );
    expect((await readdir(root)).some((n) => n.endsWith(".pending"))).toBe(
      false,
    );
  });
  it("keeps good backups on failure and releases the lease for the next attempt", async () => {
    const before = (await databaseStatus()).backups.map((b) => b.path);
    const spy = vi
      .spyOn(sqlite(), "backup")
      .mockRejectedValueOnce(new Error("QA copy failed"));
    await expect(backupDatabase()).rejects.toThrow("QA copy failed");
    expect((await databaseStatus()).backups.map((b) => b.path)).toEqual(before);
    spy.mockRestore();
    await expect(backupDatabase()).resolves.toMatchObject({ keep: 2 });
    expect(() => saveBackupSettings({ keep: 0 })).toThrow();
  });
});
describe("R3c frozen reports, shared research command and portfolio replay", () => {
  it("verifies report hashes and projects walk-forward, holdout and stress without daily arrays", async () => {
    const score = {
      return: 0.1,
      excess: 0.02,
      drawdown: 0.03,
      trades: 31,
      daily: [0.1],
    };
    const w = {
      start: "2025-01-01",
      end: "2025-06-01",
      base: score,
      doubledCost: { ...score, return: 0.08 },
      delayed: { ...score, return: 0.07 },
    };
    const raw = {
      inputHash: "a".repeat(64),
      result: {
        suites: [
          {
            suite: {
              rows: [
                {
                  id: "QA",
                  windows: [w],
                  holdout: w,
                  reasons: [],
                  passed: true,
                },
              ],
            },
          },
        ],
      },
    };
    const hash = createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
      dir = join(dataDirectory(), "research-validation");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `report-${hash}.json`), JSON.stringify(raw));
    const result = await labValidationReport(hash, "QA");
    expect(result?.windows[0]?.doubledCost.return).toBe(0.08);
    expect(result?.holdout.delayed.return).toBe(0.07);
    expect(result?.holdout.base).not.toHaveProperty("daily");
    await writeFile(
      join(dir, `report-${hash}.json`),
      JSON.stringify({ ...raw, inputHash: "b".repeat(64) }),
    );
    await expect(labValidationReport(hash, "QA")).rejects.toThrow("摘要不匹配");
    await expect(
      executeResearchCommand({ command: "inspect", market: "cn-equity" }),
    ).resolves.toMatchObject({ command: "inspect", market: "cn-equity" });
    await expect(
      executeResearchCommand({
        command: "capture",
        market: "cn-equity",
      } as never),
    ).rejects.toThrow();
  });
  it("passes the submitted object and frozen bars to the shared engine and rejects missing external inputs", async () => {
    const root = join(dataDirectory(), "tdx");
    await mkdir(join(root, "T0002/hq_cache"), { recursive: true });
    await writeFile(
      join(root, "T0002/hq_cache/gbbq"),
      Buffer.from(fixture.gbbqBase64, "base64"),
    );
    saveSettings({ ...settings(), tdxRoot: root });
    const bars = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"].map(
      (date) => ({
        date,
        open: 10,
        high: 10.2,
        low: 9.8,
        close: 10,
        volume: 100000,
        amount: 1000000,
      }),
    );
    const read = vi.fn(async () => ({
      bars,
      rawBars: bars,
      hash: "QA",
      barStore: {
        formingDates: [],
        priceRepaired: false,
        adjustmentReference: "QA",
      },
    })) as unknown as typeof readBars;
    const result = await executeLabBacktest(
      {
        type: "lab-backtest",
        input: {
          strategy,
          initial: 100000,
          start: bars[0]!.date,
          end: bars.at(-1)!.date,
        },
      },
      () => {},
      read,
    );
    expect(result.frozen.request.strategies).toEqual([strategy]);
    expect(result.result).toEqual(runPortfolio(result.frozen.request));
    expect(result.result.fills.length).toBeGreaterThan(0);
    expect(result.result.fills[0]!.date).toBe(bars[1]!.date);
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    put("job", "QA-r3c-backtest", {
      id: "QA-r3c-backtest",
      type: "backtest",
      status: "completed",
      progress: 100,
      createdAt: 1,
      updatedAt: 1,
      input: { type: "lab-backtest" },
      result,
    });
    expect(
      taskEvidence("QA-r3c-backtest")?.fields.find((f) => f.label === "成交")
        ?.value,
    ).toBe(String(result.result.fills.length));
    expect(taskState("QA-r3c-backtest")?.localEvidence).toBe(true);
    expect(taskEvidence("absent")).toBeNull();
    await expect(
      executeLabBacktest({
        type: "lab-backtest",
        input: {
          strategy: {
            ...strategy,
            entry: { kind: "external", id: "absent", side: "entry" },
          },
          initial: 100000,
          start: bars[0]!.date,
          end: bars.at(-1)!.date,
        },
      }),
    ).rejects.toThrow("外部证据");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(Infinity)).toBe("—");
    expect(formatNumber(0)).toBe("0.00");
  });
});
