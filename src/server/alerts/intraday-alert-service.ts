import type {
  IntradayAlertStatus,
  IntradayTriggerEvent,
} from "~/lib/strategy-facts/intraday-alerts";
import { beijingClock } from "~/lib/market/market-session";
import { AlertRepository } from "../db/alert-repository";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import {
  getIntradayAlertConfig,
  listIntradayWatchRules,
} from "../db/intraday-alert-config-repository";
import { enqueueAlert } from "../infra/notifications";
import { settings } from "../infra/settings";
import { fetchOverviewQuotes } from "../market/overview-quotes";
import { cnTradingCalendar } from "../pipeline/cn-trading-calendar";
import { supplementalScanDue } from "../monitoring/intraday-schedule";
import { securityQuotes } from "../data-sources/tdx/tdx-quotes";
import {
  isFresh,
  localTradingDay,
  monitorTargets,
  quoteMark,
  recordQuoteTrigger,
  sessionAt,
  type QuoteMark,
} from "./intraday-quote-tick";

type Check = {
  at: number;
  source: string | null;
  result: NonNullable<IntradayAlertStatus["lastResult"]>;
  marks: Record<string, QuoteMark>;
};
type RunResult =
  | "disabled"
  | "off"
  | "closed"
  | "lunch-break"
  | "throttled"
  | "checked"
  | "no-targets"
  | { result: "checked" | "no-targets"; preview: Check; warning: string };
const checkId = "intraday:last-check",
  recentId = "intraday:recent";

export function createIntradayAlertService({
  now = Date.now,
  readQuotes,
}: {
  now?: () => number;
  readQuotes?: typeof fetchOverviewQuotes;
} = {}) {
  let lastAttempt: number | undefined, inFlight: Promise<RunResult> | undefined;
  let calendarRetryAt = -Infinity;

  function guard(
    repo: AlertRepository,
    at: number,
    allowUnconfirmedDay = false,
  ) {
    if (!getIntradayAlertConfig(repo.db).enabled) return "disabled";
    const session = sessionAt(at, repo, allowUnconfirmedDay);
    if (session !== "trading") return session;
    if (settings().alerts.mode === "off") return "off";
    return null;
  }
  function targets(repo: AlertRepository, at: number) {
    return monitorTargets(
      repo,
      getIntradayAlertConfig(repo.db),
      listIntradayWatchRules(repo.db),
      at,
    );
  }

  async function check(
    repo: AlertRepository,
    started: number,
    manual: boolean,
    supplementalAfter: number | null,
  ): Promise<RunResult> {
    const date = beijingClock(started).date;
    let day = localTradingDay(date, repo);
    if (day === null && started >= calendarRetryAt) {
      calendarRetryAt = started + 300_000;
      day = await cnTradingCalendar(repo.db, date).session(date);
    }
    if (day === false || (day === null && !manual)) return "closed";
    const preview = day === null;
    function recheck(at: number) {
      if (beijingClock(at).date !== date) return "closed";
      const stopped = guard(repo, at, preview);
      if (stopped) return stopped;
      if (
        supplementalAfter !== null &&
        !getIntradayAlertConfig(repo.db).intradayScanEnabled
      )
        return "throttled";
      return null;
    }
    const accounts = new AccountWorkspaceRepository(repo.db);
    let version = accounts.version();
    let monitored = await targets(repo, started);
    const requestAt = now();
    const stopped = recheck(requestAt);
    if (stopped) return stopped;
    if (
      supplementalAfter !== null &&
      !supplementalScanDue(
        repo,
        getIntradayAlertConfig(repo.db),
        requestAt,
        supplementalAfter,
      )
    )
      return "throttled";
    if (!preview) lastAttempt = requestAt;
    // The provider may split Tencent requests or start TDX fallback after the previous I/O.
    const assertPolling = () => {
      if (recheck(now())) throw new Error("盘中行情轮询窗口已关闭");
    };
    const batch = !monitored.symbols.length
      ? null
      : readQuotes
        ? await readQuotes(monitored.symbols)
        : await fetchOverviewQuotes(monitored.symbols, {
            fetcher: (...args) => {
              assertPolling();
              return fetch(...args);
            },
            tdxFallback: (symbols) => {
              assertPolling();
              return securityQuotes(symbols);
            },
          });
    // Account, plan, rule or policy edits during network I/O cannot authorize old conditions.
    if (version !== accounts.version()) {
      version = accounts.version();
      monitored = await targets(repo, now());
    }
    return repo.atomic(() => {
      const at = now();
      const stopped = recheck(at);
      if (stopped) return stopped;
      accounts.assertVersion(version);
      const mode = settings().alerts.mode;
      if (mode === "off") return "off";
      const status = batch ? "checked" : "no-targets";
      const data: Check = {
        at,
        source: batch?.source ?? repo.state<Check>(checkId)?.source ?? null,
        result: {
          status,
          freshCount: 0,
          missingCount: 0,
          staleCount: 0,
          triggeredCount: 0,
        },
        marks: {},
      };
      const bySymbol = new Map(batch?.quotes.map((q) => [q.symbol, q]));
      for (const symbol of monitored.symbols) {
        const q = bySymbol.get(symbol);
        const mark = q && quoteMark(q);
        if (!mark) {
          data.result.missingCount++;
          continue;
        }
        data.marks[symbol] = mark;
        if (isFresh(mark, at)) data.result.freshCount++;
        else data.result.staleCount++;
      }
      if (preview)
        return {
          result: status,
          preview: data,
          warning: "交易日历未知，本次仅查看报价，未触发预警。",
        };
      const events: IntradayTriggerEvent[] = [];
      for (const c of monitored.conditions) {
        const mark = data.marks[c.symbol];
        if (!mark || !batch) continue;
        const event = recordQuoteTrigger(
          repo,
          c,
          mark,
          batch.source,
          at,
          mode,
          enqueueAlert,
        );
        if (event) events.push(event);
      }
      if (events.length)
        repo.saveState(
          recentId,
          [
            ...events.reverse(),
            ...(repo.state<IntradayTriggerEvent[]>(recentId) ?? []),
          ].slice(0, 30),
        );
      data.result.triggeredCount = events.length;
      repo.saveState(checkId, data);
      return status;
    });
  }
  async function tick(manual = false): Promise<RunResult> {
    const repo = new AlertRepository(),
      at = now();
    const stopped = guard(repo, at, true);
    if (stopped) return stopped;
    if (inFlight) {
      const result = await inFlight;
      if (
        manual &&
        result === "closed" &&
        localTradingDay(beijingClock(at).date, repo) === null
      )
        return tick(true);
      return result;
    }
    const config = getIntradayAlertConfig(repo.db);
    lastAttempt ??= repo.state<Check>(checkId)?.at ?? -Infinity;
    const supplemental =
      !manual && at - lastAttempt < config.pollIntervalSec * 1000;
    if (supplemental && !supplementalScanDue(repo, config, at, lastAttempt))
      return "throttled";
    inFlight = check(repo, at, manual, supplemental ? lastAttempt : null)
      .catch((error: unknown) => {
        const stopped = guard(repo, now(), true);
        if (stopped) return stopped;
        if (localTradingDay(beijingClock(now()).date, repo) === null)
          throw error;
        repo.saveState<Check>(checkId, {
          at: now(),
          source: repo.state<Check>(checkId)?.source ?? null,
          marks: {},
          result: {
            status: "error",
            freshCount: 0,
            staleCount: 0,
            missingCount: 0,
            triggeredCount: 0,
          },
        });
        throw error;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }
  async function snapshot(preview?: Check): Promise<IntradayAlertStatus> {
    const repo = new AlertRepository(),
      at = now();
    const config = getIntradayAlertConfig(repo.db);
    const rules = listIntradayWatchRules(repo.db);
    const monitored = await monitorTargets(repo, config, rules, at);
    const check = preview ?? repo.state<Check>(checkId);
    const session = sessionAt(at, repo);
    return {
      config,
      rules,
      session,
      lastCheckedAt: check?.at ?? null,
      lastResult: check?.result ?? null,
      lastQuoteSource: check?.source ?? null,
      monitoredSymbolCount: monitored.symbols.length,
      recentEvents: repo.state<IntradayTriggerEvent[]>(recentId) ?? [],
      holdings: monitored.holdings.map((p) => {
        const mark = check?.marks[p.symbol];
        return {
          ...p,
          price: mark?.price ?? null,
          quoteAt: mark?.quoteAt ?? null,
          quoteStatus: !mark
            ? "missing"
            : session === "trading" && isFresh(mark, at)
              ? "fresh"
              : "stale",
          distanceToStop:
            mark && p.stopPrice !== null ? mark.price - p.stopPrice : null,
          distanceToTarget:
            mark && p.targetPrice !== null ? p.targetPrice - mark.price : null,
        };
      }),
    };
  }
  async function runNow() {
    const outcome = await tick(true);
    if (typeof outcome === "object")
      return {
        result: outcome.result,
        warning: outcome.warning,
        snapshot: await snapshot(outcome.preview),
      };
    return { result: outcome, snapshot: await snapshot() };
  }
  return { tick, snapshot, runNow };
}

const scope = globalThis as typeof globalThis & {
  quantIntradayAlerts?: ReturnType<typeof createIntradayAlertService>;
};
const service = (scope.quantIntradayAlerts ??= createIntradayAlertService());
export const tickIntradayAlerts = () => service.tick();
export const getIntradayAlertSnapshot = () => service.snapshot();
export const runIntradayAlertsNow = () => service.runNow();
