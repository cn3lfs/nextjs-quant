import { createHash, randomUUID } from "node:crypto";
import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/czsc";
import { previewBars } from "~/lib/intraday-preview";
import {
  intradaySchedule,
  type IntradayConfig,
  type IntradaySlot,
} from "~/lib/intraday-schedule";
import { IntradayStore } from "./intraday-store";
import { evaluateIntraday } from "./intraday-strategy";
import type { intradayPool } from "./intraday-data";

export type IntradayRun = {
  id: string;
  date: string;
  slot: IntradaySlot;
  config: IntradayConfig;
  status: "running" | "complete" | "partial" | "failed" | "missed";
  startedAt: number;
  updatedAt: number;
  owner: string;
  leaseUntil: number;
  previousTradingDay: string;
  calendarSource: string;
  pool: Awaited<ReturnType<typeof intradayPool>> | null;
  results: {
    symbol: string;
    observationId: string | null;
    reason: string | null;
  }[];
  error: string | null;
};
export type IntradayDependencies = {
  now(): number;
  calendar(): Promise<{
    days: string[];
    closedDays?: string[];
    source: string;
  }>;
  pool(config: IntradayConfig, date: string): ReturnType<typeof intradayPool>;
  history(
    source: IntradayConfig["source"],
    symbol: string,
  ): Promise<{ daily: Bar[]; minutes: Bar[]; fetchedAt: number }>;
  czsc(bars: readonly Bar[]): Promise<CzscResult>;
};

export class IntradayJob {
  constructor(
    readonly store: IntradayStore,
    readonly dependencies: IntradayDependencies,
  ) {}
  runs() {
    const rows = this.store.db
      .prepare(
        "SELECT payload FROM records WHERE kind='intraday-run' ORDER BY updated_at DESC LIMIT 100",
      )
      .all() as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as IntradayRun);
  }
  private read(id: string) {
    const row = this.store.db
      .prepare("SELECT payload FROM records WHERE id=? AND kind='intraday-run'")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as IntradayRun) : undefined;
  }
  private save(run: IntradayRun, claim = false) {
    run.updatedAt = this.dependencies.now();
    run.leaseUntil = run.updatedAt + 15 * 60000;
    const written = this.store.db
      .prepare(
        "INSERT INTO records VALUES (?,'intraday-run',?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at WHERE ?=1 OR json_extract(records.payload,'$.owner')=?",
      )
      .run(
        run.id,
        JSON.stringify(run),
        run.updatedAt,
        Number(claim),
        run.owner,
      );
    if (!written.changes) throw new Error("预选任务已由另一执行者接管");
  }

  async preview(config: IntradayConfig, slot: IntradaySlot) {
    const deps = this.dependencies;
    const calendar = await deps.calendar();
    const now = deps.now();
    const schedule = intradaySchedule(config, now, calendar);
    const window = schedule.slots.find((value) => value.slot === slot)!;
    if (
      !["due", "missed"].includes(window.status) ||
      !schedule.previousTradingDay
    )
      throw new Error(`当前不能预选：${window.status}`);
    const id = `intraday-run:${createHash("sha256")
      .update(JSON.stringify([schedule.date, slot, config]))
      .digest("hex")}`;
    const run = this.store.db
      .transaction(() => {
        const previous = this.read(id);
        if (
          previous?.status === "complete" ||
          previous?.status === "missed" ||
          (previous?.status === "running" && previous.leaseUntil > now)
        )
          return null;
        // Expired slots can retain existing observations, but cannot add new ones.
        const value: IntradayRun = previous ?? {
          id,
          date: schedule.date,
          slot,
          config,
          status: "running",
          startedAt: now,
          updatedAt: now,
          owner: "",
          leaseUntil: now,
          previousTradingDay: schedule.previousTradingDay!,
          calendarSource: calendar.source,
          pool: null,
          results: [],
          error: null,
        };
        value.status = window.status === "missed" ? "missed" : "running";
        value.owner = randomUUID();
        value.error = null;
        this.save(value, true);
        return value;
      })
      .immediate();
    if (!run || run.status === "missed") return this.read(id)!;
    try {
      run.pool ??= await deps.pool(config, run.previousTradingDay);
      const poolHash = run.pool.hash;
      this.save(run);
      for (const row of run.pool.rows) {
        if (
          run.results.some(
            (result) => result.symbol === row.symbol && result.observationId,
          )
        )
          continue;
        if (deps.now() >= Date.parse(window.barCutoff) + 5 * 60000) {
          run.error = "预选窗口已结束，剩余股票未执行";
          break;
        }
        const result = {
          symbol: row.symbol,
          observationId: null as string | null,
          reason: null as string | null,
        };
        try {
          const history = await deps.history(config.source, row.symbol);
          if (history.fetchedAt >= Date.parse(window.barCutoff) + 5 * 60000)
            throw new Error("行情读取完成时已错过预选窗口");
          const bars = previewBars({
            date: run.date,
            previousTradingDay: run.previousTradingDay,
            cutoff: config[slot],
            observedAt: history.fetchedAt,
            ...history,
          });
          const value = await evaluateIntraday(
            {
              symbol: row.symbol,
              source: config.source,
              observedAt: history.fetchedAt,
              barCutoff: window.barCutoff,
              bars,
              config: config.czscConfig,
            },
            deps.czsc,
          );
          result.observationId = this.store.db
            .transaction(() => {
              if (this.read(id)?.owner !== run.owner)
                throw new Error("预选任务已由另一执行者接管");
              return this.store.record({
                ...value,
                capturedAt: history.fetchedAt,
                observedAt: deps.now(),
                sessionId: id,
                rpsDate: run.previousTradingDay,
                rps: row.rps,
                poolHash,
              }).id;
            })
            .immediate();
        } catch (error) {
          result.reason = error instanceof Error ? error.message : "预选失败";
        }
        run.results = [
          ...run.results.filter((old) => old.symbol !== row.symbol),
          result,
        ];
        this.save(run);
      }
      run.status =
        run.error || run.results.some((result) => result.reason)
          ? "partial"
          : "complete";
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : "预选失败";
    }
    this.save(run);
    return run;
  }

  async confirm(id: string) {
    const deps = this.dependencies;
    const observation = this.store.observation(id);
    if (!observation) throw new Error("预选记录不存在");
    const run = this.read(observation.sessionId);
    if (!run) throw new Error("预选批次不存在");
    if (deps.now() < Date.parse(`${run.date}T15:05:00+08:00`))
      throw new Error("尚未到收盘确认时间");
    const settled = this.store
      .attempts(id)
      .find((attempt) => attempt.close.signalKeys !== null);
    if (settled) return settled;
    try {
      const history = await deps.history(
        observation.snapshot.source,
        observation.snapshot.symbol,
      );
      // Keep the exact captured historical prefix; only extend today's minute
      // prefix. Later source revisions must not silently rewrite the experiment.
      const bars = previewBars({
        date: run.date,
        previousTradingDay: run.previousTradingDay,
        cutoff: "15:00",
        observedAt: history.fetchedAt,
        daily: observation.snapshot.bars.slice(0, -1),
        minutes: history.minutes,
      });
      const value = await evaluateIntraday(
        {
          symbol: observation.snapshot.symbol,
          source: observation.snapshot.source,
          observedAt: history.fetchedAt,
          barCutoff: `${run.date}T15:00:00+08:00`,
          bars,
          config: run.config.czscConfig,
        },
        deps.czsc,
      );
      if (value.engineVersion !== observation.engineVersion)
        throw new Error("收盘缠论版本与预选不一致");
      for (const signal of observation.signals) {
        const matching = value.signals.find(
          (candidate) => candidate.key === signal.key,
        );
        if (matching && matching.strategyVersion !== signal.strategyVersion)
          throw new Error("收盘策略版本与预选不一致");
      }
      return this.store.confirm(id, {
        observedAt: deps.now(),
        snapshotHash: value.snapshotHash,
        snapshot: value.snapshot,
        signalKeys: value.signals.map((signal) => signal.key),
        reason: null,
      });
    } catch (error) {
      return this.store.confirm(id, {
        observedAt: deps.now(),
        snapshotHash: null,
        signalKeys: null,
        reason: error instanceof Error ? error.message : "收盘计算失败",
      });
    }
  }
}
