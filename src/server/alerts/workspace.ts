import { planSizingPolicy } from "./plan-sizing";
import { candidateScanFreshness } from "./candidate-scan";
import { closeScanPhase } from "~/lib/market/close-scan-window";
import { settings } from "../infra/settings";
import { AlertRepository } from "../db/alert-repository";
import { previewAlertPlan } from "./plans";
import type { ShadowRegistration } from "./shadow";
import {
  alertHistorySchema,
  effectiveMarketCapital,
  type AlertEvent,
} from "~/lib/strategy-facts/alerts";
import { downloadReady } from "../jobs/workflow-scheduler";
import {
  publicDataRoot,
  publicDataStatus,
} from "../data-sources/binance/public-data-store";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import type { regimeObservation } from "./observations";
import type { LowZoneObservation } from "trading-strategies";
import { equityDailyReadiness } from "./readiness";
import { planExposure } from "./plan-exposure";
import { stopTasks } from "../portfolio/holding-protection-service";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { strategyLabDetail } from "../db/strategy-lab";
import { loadAccountBook } from "../portfolio/account-workspace-service";
import type { AccountPosition } from "~/lib/portfolio/account-workspace";
import type { TradePlan } from "../db/strategy-repository";

const PLAN_ROWS = 20;
const INACTIVE_ROWS = 3;
export type PlanExpiryState = "valid" | "due-soon" | "unverified" | "expired";
function planExpiryAt(plan: { expiresAt: string | null }) {
  if (plan.expiresAt === null) return null;
  const at = Date.parse(plan.expiresAt);
  return Number.isFinite(at) ? at : null;
}
/**
 * Read-only view of open plans. Expiry drives only the display status: a plan
 * is never closed or re-verified here.
 */
export function todayOpenPlans(plans: readonly TradePlan[], now: number) {
  const state = (plan: TradePlan): PlanExpiryState => {
    const at = planExpiryAt(plan);
    if (at === null) return "unverified";
    if (at <= now) return "expired";
    if (at <= now + 86400000) return "due-soon";
    return "valid";
  };
  const rows = plans.map((plan) => ({ ...plan, expiryState: state(plan) }));
  const active = rows
    .filter((p) => p.expiryState === "valid" || p.expiryState === "due-soon")
    .sort(
      (a, b) =>
        (planExpiryAt(a) ?? 0) - (planExpiryAt(b) ?? 0) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const unverified = rows.filter((p) => p.expiryState === "unverified");
  const expired = rows.filter((p) => p.expiryState === "expired");
  const reserved =
    Math.min(unverified.length, INACTIVE_ROWS) +
    Math.min(expired.length, INACTIVE_ROWS);
  return {
    total: rows.length,
    valid: active.length,
    dueSoon: rows.filter((p) => p.expiryState === "due-soon").length,
    unverified: unverified.length,
    expired: expired.length,
    items: [
      ...active.slice(0, Math.max(0, PLAN_ROWS - reserved)),
      ...unverified.slice(0, INACTIVE_ROWS),
      ...expired.slice(0, INACTIVE_ROWS),
    ],
  };
}

export type RegimeSnapshot = NonNullable<
  ReturnType<typeof regimeObservation>
> & {
  bar?: string;
  source?: string;
  observedAt?: number;
  low?: LowZoneObservation;
};
export type HoldingRiskSnapshot = {
  market: "cn-equity" | "crypto";
  symbol: string;
  account: string;
  quantity: number;
  price: number;
  cost: number | null;
  stop: number | null;
  bar: string;
  observedAt: number;
  sleeve: string;
};
export function workspaceCandidate(
  event: AlertEvent,
  repo = new AlertRepository(),
  now = Date.now(),
  positions?: readonly AccountPosition[],
) {
  const shadow = repo.state<ShadowRegistration>(
    `shadow:${event.strategyId}:${event.version}`,
  );
  const definition = repo.strategies.strategy(event.strategyId, event.version);
  const qualification = strategyLabDetail(
    event.strategyId,
    event.version,
    repo,
  );
  const status =
    qualification.eligible && qualification.promotion
      ? "promoted"
      : shadow?.active
        ? "shadow"
        : "research";
  let quantity: number | null = null;
  let quantityReason: string | null = null;
  let positionSnapshot: {
    at: number;
    basis: "intraday" | "post-close";
    unassignedValue: number;
  } | null = null;
  try {
    if (event.price === null || event.stop === null)
      throw new Error("缺入场或止损依据");
    const plan = previewAlertPlan(
      {
        eventKey: event.key,
        stages: Array.from(
          { length: definition?.sizing.tranches ?? 1 },
          () => event.price!,
        ),
        stop: event.stop,
        target: event.target,
        expiresAt: new Date(now + 86400000).toISOString(),
      },
      settings(),
      now,
      repo,
      positions,
    );
    quantity = plan.quantity;
    positionSnapshot = plan.positionSnapshot;
  } catch (error) {
    quantityReason = error instanceof Error ? error.message : "数量不可用";
  }
  let sizingPolicy: ReturnType<typeof planSizingPolicy> | null = null;
  let policyReason: string | null = null;
  try {
    if (definition)
      sizingPolicy = planSizingPolicy(definition, event, settings(), repo);
  } catch (failure) {
    policyReason =
      failure instanceof Error ? failure.message : "仓位来源不可用";
  }
  return {
    ...event,
    sizingPolicy,
    policyReason,
    qualification: status as "research" | "shadow" | "promoted",
    quantity,
    quantityReason,
    positionSnapshot,
    tranches: definition?.sizing.tranches ?? 1,
    exitSpec: definition?.exit ?? null,
    adjustment:
      event.market === "cn-equity"
        ? "策略复权基准；入场/止损/目标原价"
        : "不复权 · UTC",
  };
}
export type CandidateScanContext = {
  closeDate: string | null;
  calendar: readonly string[];
};
export function workspaceCandidates(
  input: {
    page: number;
    strategy?: string;
    market?: "cn-equity" | "crypto";
    minimumRps?: number;
  },
  repo = new AlertRepository(),
  now = Date.now(),
  positions?: readonly AccountPosition[],
  scan?: CandidateScanContext,
) {
  const result = repo.candidatePage(input);
  const scans = scan ? repo.candidateScans() : null;
  const annotate = (event: AlertEvent) => {
    const candidate = workspaceCandidate(event, repo, now, positions);
    // Crypto and the /scan history keep their original presentation.
    if (!scan || !scans || event.market !== "cn-equity")
      return { ...candidate, scanFreshness: null, scanAt: null };
    const stored = scans.get(
      `${event.market}:${event.strategyId}:${event.version}`,
    );
    const period =
      stored?.period ??
      repo.strategies.strategy(event.strategyId, event.version)?.period;
    return {
      ...candidate,
      scanFreshness: period
        ? candidateScanFreshness(stored, period, scan)
        : ("unknown" as const),
      scanAt: stored?.observedAt ?? null,
    };
  };
  return {
    ...result,
    items: result.items.map((e) => {
      const row = annotate(e);
      const sources = e.sources.map(annotate);
      return {
        ...row,
        rps20: e.rps20,
        rpsDate: e.rpsDate,
        sources,
        scan:
          row.scanFreshness === null
            ? null
            : {
                current: sources.every(
                  (source) => source.scanFreshness === "current",
                ),
                hasHistorical: sources.some(
                  (source) => source.scanFreshness === "stale",
                ),
                hasUnverified: sources.some(
                  (source) =>
                    source.scanFreshness === "intraday" ||
                    source.scanFreshness === "unknown",
                ),
              },
      };
    }),
  };
}
export async function todayWorkspace(
  now = Date.now(),
  repo = new AlertRepository(),
) {
  const config = settings();
  const book = await loadAccountBook(
    new AccountWorkspaceRepository(repo.db),
    config,
    now,
    { localOnly: true },
  );
  const symbols = [
    ["cn-equity", "sh000300"],
    ["cn-equity", "sz399006"],
    ["crypto", "BTCUSDT"],
    ["crypto", "ETHUSDT"],
  ] as const;
  const regimes = symbols.map(([market, symbol]) => ({
    market,
    symbol,
    value: repo.state<RegimeSnapshot>(`regime:${market}:${symbol}`) ?? null,
  }));
  const sleeves = config.alerts.sleeves.map((s) => {
    const snapshot = planExposure(s.market, config, now, repo);
    const marker = snapshot.usage.find(
      (e) => e.market === s.market && e.sleeve === "__checked__",
    );
    const fresh = snapshot.valid;
    const value = marker
      ? snapshot.usage
          .filter((e) => e.market === s.market && e.sleeve === s.id)
          .reduce((n, e) => n + e.value, 0)
      : null;
    const marketCapital = effectiveMarketCapital(config.alerts, s.market);
    const actual = value !== null ? value / marketCapital : null;
    return {
      ...s,
      value,
      actual,
      fresh,
      at: marker?.at ?? null,
      snapshotBasis: snapshot.basis,
      drift: actual !== null && Math.abs(actual - s.share) >= 0.1,
    };
  });
  const archive = await publicDataStatus(
    publicDataRoot(config.binancePublicDataRoot),
    now,
  );
  // Reuse the readiness reference date and its already-read calendar; the
  // persisted notification calendar may not have refreshed yet.
  const { calendar, ...equity } = await equityDailyReadiness(config, now);
  const closeRecord =
    equity.expectedDate === null
      ? undefined
      : repo.state<{ status?: string; at?: number }>(
          `close:${equity.expectedDate}`,
        );
  const close = closeScanPhase(equity.expectedDate, closeRecord, now, calendar);
  const protectionTasks = await stopTasks(
    new AccountWorkspaceRepository(repo.db),
    config,
    now,
    book,
  );
  const openPlans = todayOpenPlans(repo.plans(true), now);
  return {
    now,
    mode: config.alerts.mode,
    regimes,
    sleeves,
    holdings: repo.state<HoldingRiskSnapshot[]>("holding-risk") ?? null,
    runtime:
      repo.state<{ lastCheck: number; lastPhase?: string; error?: string }>(
        "runtime",
      ) ?? null,
    receipt: await downloadReady(chinaClock(now).date, now),
    archive,
    readiness: {
      equity,
      crypto: {
        ready: archive.alertReadiness.every((s) => s.ready),
        series: archive.alertReadiness,
      },
    },
    closeScan: {
      date: equity.expectedDate,
      ...close,
      at: closeRecord?.at ?? null,
      strategies: repo
        .watchedStrategies()
        .filter((s) => s.market === "cn-equity").length,
    },
    capital: {
      "cn-equity": effectiveMarketCapital(config.alerts, "cn-equity"),
      crypto: effectiveMarketCapital(config.alerts, "crypto"),
    },
    gaps: repo.dataGaps(),
    candidates: workspaceCandidates({ page: 0 }, repo, now, book.positions, {
      closeDate: equity.expectedDate,
      calendar,
    }),
    openPlans,
    stopTasks: protectionTasks,
    triggered: repo.history(
      alertHistorySchema.parse({ from: chinaClock(now).date, size: 10 }),
    ),
  };
}
