import { settings } from "../infra/settings";
import { AlertRepository } from "../db/alert-repository";
import { previewAlertPlan } from "./plans";
import type { ShadowRegistration } from "./shadow";
import {
  alertHistorySchema,
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
type Exposure = { market: string; sleeve: string; value: number; at: number };
export function workspaceCandidate(
  event: AlertEvent,
  repo = new AlertRepository(),
  now = Date.now(),
) {
  const qualification = repo.records.read<{
    status: string;
    strategyVersion?: number;
  }>(`strategy-qualification-${event.strategyId}`);
  const shadow = repo.state<ShadowRegistration>(
    `shadow:${event.strategyId}:${event.version}`,
  );
  const status =
    qualification?.status === "live-candidate" &&
    (qualification.strategyVersion ?? 1) === event.version
      ? "promoted"
      : shadow?.active
        ? "shadow"
        : "research";
  let quantity: number | null = null;
  let quantityReason: string | null = null;
  try {
    if (event.price === null || event.stop === null)
      throw new Error("缺入场或止损依据");
    quantity = previewAlertPlan(
      {
        eventKey: event.key,
        stages: [event.price],
        stop: event.stop,
        target: event.target,
        expiresAt: new Date(now + 86400000).toISOString(),
      },
      settings(),
      now,
      repo,
    ).quantity;
  } catch (error) {
    quantityReason = error instanceof Error ? error.message : "数量不可用";
  }
  return {
    ...event,
    qualification: status as "research" | "shadow" | "promoted",
    quantity,
    quantityReason,
    adjustment:
      event.market === "cn-equity"
        ? "信号前复权；入场/止损/目标原价"
        : "不复权 · UTC",
  };
}
export function workspaceCandidates(
  input: {
    page: number;
    strategy?: string;
    market?: "cn-equity" | "crypto";
    minimumRps?: number;
  },
  repo = new AlertRepository(),
  now = Date.now(),
) {
  const result = repo.candidatePage(input);
  return {
    ...result,
    items: result.items.map((e) => ({
      ...workspaceCandidate(e, repo, now),
      rps20: e.rps20,
      rpsDate: e.rpsDate,
    })),
  };
}
export async function todayWorkspace(
  now = Date.now(),
  repo = new AlertRepository(),
) {
  const config = settings();
  const exposure = repo.state<Exposure[]>("exposure") ?? [];
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
    const marker = exposure.find(
      (e) => e.market === s.market && e.sleeve === "__checked__",
    );
    const fresh =
      !!marker &&
      now - marker.at <= 600000 &&
      exposure
        .filter((e) => e.market === s.market)
        .every((e) => now - e.at <= 600000);
    const value = marker
      ? exposure
          .filter((e) => e.market === s.market && e.sleeve === s.id)
          .reduce((n, e) => n + e.value, 0)
      : null;
    const actual =
      value !== null && config.alerts.capital[s.market] > 0
        ? value / config.alerts.capital[s.market]
        : null;
    return {
      ...s,
      value,
      actual,
      fresh,
      at: marker?.at ?? null,
      drift: actual !== null && Math.abs(actual - s.share) >= 0.1,
    };
  });
  const archive = await publicDataStatus(
    publicDataRoot(config.binancePublicDataRoot),
  );
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
    candidates: workspaceCandidates({ page: 0 }, repo, now),
    triggered: repo.history(
      alertHistorySchema.parse({ from: chinaClock(now).date, size: 10 }),
    ),
  };
}
