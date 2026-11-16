import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { historicalLowSeries } from "trading-strategies";
import type { HoldingRiskSnapshot } from "./workspace";
import { createHash } from "node:crypto";
import type {
  StrategyObjectInput,
  StrategyExternalInputs,
} from "trading-strategies";
import { settings } from "../infra/settings";
import { get, readRecordSnapshot } from "../db";
import { AlertRepository } from "../db/alert-repository";
import { RpsStore } from "../db/rps-store";
import { readBars } from "../market/bar-store/read-bars";
import { beijingClock } from "~/lib/market/market-session";
import { cryptoSymbol, isCryptoSymbol } from "~/lib/market/crypto";
import { closeScanDeadline } from "~/lib/market/close-scan-window";
import type { SecurityTradingStatus } from "~/lib/market/security-trading-status";
import { cryptoPeriodEnd } from "~/lib/market/crypto-aggregation";
import { watchStrategy } from "../strategies/drivers/watch";
import { captureNativeChanObservations } from "../strategies/strategy-center-native";
import { analyzeCzsc } from "../strategies/chan/czsc";
import type { AlertEvaluation, AlertPhase, AlertProposal } from "./engine";
import {
  holdingObservation,
  regimeObservation,
  type HoldingProtection,
  type HoldingWatchState,
} from "./observations";
import { candidateScanWatermark } from "./candidate-scan";
import { HoldingProtectionRepository } from "../db/holding-protection-repository";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { DeliveryStore } from "../db/delivery-store";
import { loadAccountBook } from "../portfolio/account-workspace-service";
import {
  holdingProtectionCurrent,
  observeHoldingProtection,
  protectionPositionKey,
  type HoldingProtectionProjection,
} from "~/lib/portfolio/holding-protection";
import { tradePositionState } from "../portfolio/trade-ledger-service";
import type { BotState } from "../crypto-trading/model";
import type { Period, Bar } from "~/lib/domain";
import { recordRuntimeError } from "../infra/runtime-errors";
import { verifySecurityTradingStatus } from "../market/security-trading-status";
import { currentTradingStatus } from "~/lib/market/security-trading-status";
import {
  appendShadowSamples,
  assessShadow,
  shadowBarCompletedAt,
  type ShadowRegistration,
  type ShadowProgress,
  type ShadowSample,
} from "./shadow";
import { evaluateStrategySeries } from "../strategies/drivers/evaluation";
import { corporateActions } from "../market/bar-store/corporate-actions";
import { researchCorporateActions } from "../research/corporate-actions";

export function systemWatch(
  id: string,
  market: "cn-equity" | "crypto",
  symbol: string,
  sleeve = "swing",
): StrategyObjectInput {
  return {
    id,
    version: 1,
    market,
    period: "5m",
    sleeve,
    universe: { kind: "symbols", symbols: [symbol] },
    entry: { kind: "constant", value: false },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
  };
}
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
type Exposure = {
  market: "cn-equity" | "crypto";
  sleeve: string;
  value: number;
  at: number;
};
export async function evaluateAlertInputs(
  phase: AlertPhase,
  now: number,
  repo: AlertRepository,
  closeDate?: string,
): Promise<AlertEvaluation> {
  const config = settings();
  const market: "cn-equity" | "crypto" =
    phase === "crypto" ? "crypto" : "cn-equity";
  const today = closeDate ?? beijingClock(now).date;
  const validity = (period: Period, completedAt: number, bar: string) => {
    if (phase !== "close" && period !== "day" && period !== "week")
      return 5 * 60000;
    if (market === "crypto") return 12 * 3600000;
    // The engine accepts an inclusive age; the pre-open cutoff itself is closed.
    return Math.max(
      0,
      closeScanDeadline(bar.slice(0, 10), repo.records.days()) -
        completedAt -
        1,
    );
  };
  const result: AlertEvaluation = { proposals: [], states: [] };
  const cache = new Map<string, Awaited<ReturnType<typeof readBars>>>();
  const series = async (symbol: string, period: Period, adjusted = false) => {
    const key = `${symbol}:${period}:${adjusted}`;
    let data = cache.get(key);
    if (!data) {
      data = await readBars({
        instrument: {
          market,
          symbol:
            market === "crypto" && !isCryptoSymbol(symbol)
              ? cryptoSymbol(symbol)
              : symbol,
        },
        period,
        adjustment: adjusted && market === "cn-equity" ? "forward" : "none",
        freezeRaw: adjusted,
        root: config.tdxRoot,
        to: market === "cn-equity" && period === "day" ? today : undefined,
        now,
        live: phase !== "close",
        limit: market === "crypto" ? 3000 : undefined,
      });
      cache.set(key, data);
    }
    const gapId = `data-gap:${market}:${symbol}`;
    if (
      !result.states.some(
        (s) => s.id === gapId && !(s.value as { resolved?: boolean }).resolved,
      )
    )
      result.states.push({ id: gapId, value: { at: now, resolved: true } });
    const bars = data.bars.filter(
      (b) => !data.barStore.formingDates.includes(b.date),
    );
    const completedDates = new Set(bars.map((b) => b.date));
    const rawBars =
      "rawBars" in data
        ? (data.rawBars as Bar[]).filter((b) => completedDates.has(b.date))
        : bars;
    return {
      symbol,
      market,
      bars,
      rawBars,
      source: `${data.source} / ${data.adjustment} / ${data.hash}`,
      completedAt: (bar: string) =>
        market === "crypto"
          ? cryptoPeriodEnd(bar, period)
          : period === "day" || period === "week"
            ? Date.parse(`${bar.slice(0, 10)}T15:05:00+08:00`)
            : Date.parse(bar),
    };
  };
  const error = (symbol: string, error: unknown) => {
    recordRuntimeError("alert-engine", error);
    result.states = result.states.filter(
      (s) => s.id !== `data-gap:${market}:${symbol}`,
    );
    result.states.push({
      id: `data-gap:${market}:${symbol}`,
      value: { at: now, reason: "行情或策略所需证据不可用；未生成假信号" },
    });
  };
  const propose = (
    strategy: StrategyObjectInput,
    symbol: string,
    bar: string,
    type: AlertProposal["event"]["type"],
    price: number | null,
    reason: string,
    source: string,
    completedAt: number,
    rest: Partial<AlertProposal["event"]> = {},
  ) => {
    result.proposals.push({
      strategy,
      completedAt,
      windowMs: validity(strategy.period, completedAt, bar),
      event: {
        strategyId: strategy.id,
        version: strategy.version,
        market,
        symbol,
        bar,
        type,
        price,
        sleeve: strategy.sleeve,
        stop: null,
        target: null,
        reason,
        source,
        ...rest,
      },
    });
  };
  const strategies = repo
    .watchedStrategies()
    .filter(
      (s) =>
        s.market === market &&
        (phase === "close"
          ? s.period === "day" || s.period === "week"
          : phase === "intraday"
            ? s.period !== "day" && s.period !== "week"
            : true),
    );
  for (const strategy of strategies) {
    const scan = candidateScanWatermark(strategy, now, closeDate);
    result.states.push(scan);
    const shadow = repo.state<ShadowRegistration>(
      `shadow:${strategy.id}:${strategy.version}`,
    );
    const shadowOnly = shadow?.active === true;
    const fresh: ShadowSample[] = [];
    const registrationId = `strategy:${strategy.id}:${strategy.version}`;
    const registration = JSON.stringify(repo.state(registrationId));
    const configured =
      repo.state<string[]>(`universe:${strategy.id}:${strategy.version}`) ?? [];
    const selected =
      strategy.universe.kind === "symbols"
        ? strategy.universe.symbols
        : [...(get<string[]>("watchlist") ?? []), ...configured];
    const seen = new Set<string>();
    const symbols = selected.filter((symbol) => {
      if (
        !(market === "crypto"
          ? /^(cx)?[A-Z0-9]+USDT$/.test(symbol)
          : /^(sh|sz)\d{6}$/.test(symbol))
      )
        return false;
      const identity =
        market === "crypto"
          ? isCryptoSymbol(symbol)
            ? symbol
            : cryptoSymbol(symbol)
          : symbol;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    for (const symbol of symbols) {
      try {
        const data = await series(symbol, strategy.period, true);
        const bar = data.bars.at(-1);
        if (!bar) continue;
        if (
          market === "cn-equity" &&
          strategy.period !== "day" &&
          (!scan.value.bar || bar.date > scan.value.bar)
        )
          scan.value.bar = bar.date;
        const prospectiveCompletedAt = shadowBarCompletedAt(
          market,
          strategy.period,
          bar.date,
          data.completedAt(bar.date),
        );
        if (shadowOnly && prospectiveCompletedAt < shadow.startedAt) continue;
        const external: StrategyExternalInputs = {};
        const rules = [strategy.entry, strategy.exit?.rule].filter((r) => !!r);
        if (
          rules.some((r) => r.kind === "rps" || r.kind === "formula") ||
          strategy.universe.kind === "rps"
        ) {
          const store = new RpsStore(repo.db);
          const day = store.day(bar.date);
          const row =
            day && store.rows(day.date).find((r) => r.symbol === symbol);
          external.rps =
            day && row
              ? [{ date: day.date, periods: day.periods, values: row.values }]
              : [];
        }
        const native = rules.find((r) => r.kind === "chan-third-buy");
        if (native?.kind === "chan-third-buy")
          external.chan = (
            await captureNativeChanObservations(data.bars, native.firstIndex)
          ).observations;
        const monitor = rules.find((r) => r.kind === "czsc-monitor");
        if (monitor?.kind === "czsc-monitor") {
          const nativeResult = await analyzeCzsc(data.bars, true);
          const signals =
            nativeResult.families.find((f) => f.config === monitor.config)
              ?.signals ?? [];
          const key = `native:${strategy.id}:${strategy.version}:${symbol}`;
          const observations = signals.map((s) => ({
            date: bar.date,
            availableAt: bar.date,
            endpointDate: s.date,
            config: monitor.config,
            key: `${monitor.config}:${s.date}:${s.kind}`,
            kind: s.kind,
            quality: s.quality,
          }));
          external.monitorCzsc = {
            observations,
            seenKeys: repo.state<string[]>(key),
          };
          result.states.push({
            id: key,
            value: [
              ...new Set([
                ...(external.monitorCzsc.seenKeys ?? []),
                ...observations.map((o) => o.key),
              ]),
            ],
          });
        }
        const events = watchStrategy(
          strategy,
          { ...data, external },
          bar.date,
          { membership: symbols },
        );
        const completedAt = data.completedAt(bar.date);
        if (
          shadowOnly &&
          completedAt >= shadow.startedAt &&
          now >= completedAt &&
          now - completedAt <= validity(strategy.period, completedAt, bar.date)
        ) {
          const benchmarkData = await series(
            market === "crypto" ? "BTCUSDT" : "sh000906",
            strategy.period,
          );
          const benchmark = benchmarkData.rawBars.find(
            (b) => b.date === bar.date,
          );
          const raw = data.rawBars.find((b) => b.date === bar.date);
          const evaluation = evaluateStrategySeries(
            strategy,
            { ...data, external },
            bar.date,
          );
          if (raw && benchmark && evaluation) {
            const actions =
              market === "cn-equity"
                ? await corporateActions(config.tdxRoot)
                : null;
            fresh.push({
              symbol,
              bar: raw,
              benchmark,
              observedAt: now,
              completedAt: prospectiveCompletedAt,
              source: data.source,
              entry: evaluation.decision.entry,
              exit: evaluation.decision.exit,
              stop: evaluation.decision.stopLevel,
              actions: actions
                ? researchCorporateActions(
                    actions.events.get(symbol) ?? [],
                    actions.fingerprint,
                    bar.date,
                    bar.date,
                  )
                : [],
            });
          }
        }
        for (const event of events) {
          if (event.type === "entry" && bar.volume <= 0) continue;
          let status: SecurityTradingStatus | undefined;
          if (market === "cn-equity" && event.type === "entry") {
            try {
              status = await verifySecurityTradingStatus(symbol);
            } catch (failure) {
              recordRuntimeError("alert-engine", failure);
              const evidence = { row: {}, columns: [] };
              status = {
                version: "security-trading-status-1",
                symbol,
                status: "unknown",
                asOf: null,
                fetchedAt: now,
                source: "同花顺问财核验不可用",
                reason: "交易状态未知，请核验",
                evidence,
                evidenceHash: createHash("sha256")
                  .update(JSON.stringify(evidence))
                  .digest("hex"),
              };
            }
            if (status.status === "suspended") continue;
          }
          const statusUnknown =
            status && !currentTradingStatus(status, symbol, now);
          if (statusUnknown && status)
            status = {
              ...status,
              status: "unknown",
              reason: "交易状态未知或证据已过期，请核验",
            };
          propose(
            strategy,
            symbol,
            event.bar,
            event.type,
            event.price,
            `${phase === "close" ? "收盘扫描：明日计划候选" : "已完成bar策略触发"}；规则${strategy.entry.kind}，完成bar ${event.bar}，原价${event.price}，入场=${event.type === "entry"}，止损=${event.stop ?? "无"}，目标=${event.target ?? "无"}${statusUnknown ? "；交易状态未知，请核验；仅影子记录" : ""}`,
            data.source,
            data.completedAt(bar.date),
            {
              stop: event.stop,
              target: event.target,
              ...(status ? { tradingStatusEvidence: status } : {}),
            },
          );
          result.proposals.at(-1)!.authorize = (at) =>
            (shadowOnly
              ? repo.state<ShadowRegistration>(
                  `shadow:${strategy.id}:${strategy.version}`,
                )?.active === true
              : JSON.stringify(repo.state(registrationId)) === registration) &&
            (!status ||
              statusUnknown ||
              currentTradingStatus(status, symbol, at));
          result.proposals.at(-1)!.shadowOnly =
            shadowOnly || Boolean(statusUnknown);
          const nativeState = result.states.find(
            (s) =>
              s.id === `native:${strategy.id}:${strategy.version}:${symbol}`,
          );
          if (nativeState)
            nativeState.authorize = result.proposals.at(-1)!.authorize;
        }
      } catch (e) {
        error(symbol, e);
      }
    }
    if (shadowOnly && fresh.length) {
      const key = `shadow-progress:${strategy.id}:${strategy.version}`;
      const previous = repo.state<ShadowProgress>(key);
      const next = appendShadowSamples(previous, shadow, fresh);
      if (
        previous &&
        next.samples.length === previous.samples.length &&
        next.paused === previous.paused
      )
        continue;
      const freshObjects = new Set(fresh);
      const authorize = (at: number) =>
        repo.state<ShadowRegistration>(
          `shadow:${strategy.id}:${strategy.version}`,
        )?.active === true &&
        fresh.every(
          (s) =>
            at >= s.completedAt &&
            at - s.completedAt <=
              validity(strategy.period, s.completedAt, s.bar.date),
        );
      // Evaluate once per newly observed market day after the sample threshold.
      if (
        !next.assessment ||
        new Date(next.assessment.at).toISOString().slice(0, 10) !==
          new Date(now).toISOString().slice(0, 10)
      )
        next.assessment = assessShadow(
          strategy,
          shadow,
          next,
          now,
          repo.records.days(),
        );
      result.states.push({
        id: key,
        value: next,
        atCommit: (at) => ({
          ...next,
          samples: next.samples.map((s) =>
            freshObjects.has(s) ? { ...s, observedAt: at } : s,
          ),
        }),
        authorize,
      });
      result.states.push({
        id: `shadow-summary:${strategy.id}:${strategy.version}`,
        value: {
          signals: next.signals,
          days: next.days.length,
          paused: next.paused,
          assessment: next.assessment,
        },
        authorize,
      });
    }
  }
  const exposure: Exposure[] = [];
  const holdingRisks: HoldingRiskSnapshot[] = [];
  let exposureComplete = true;
  const watchHolding = async (
    id: string,
    symbol: string,
    quantity: number,
    protection: HoldingProtection,
    sleeve: string,
    cost: number | null = null,
  ) => {
    try {
      const data = await series(symbol, phase === "close" ? "day" : "5m");
      const bar = data.bars.at(-1);
      if (!bar) throw new Error("Missing completed holding bar");
      if (
        now - data.completedAt(bar.date) >
        validity(
          phase === "close" ? "day" : "5m",
          data.completedAt(bar.date),
          bar.date,
        )
      )
        exposureComplete = false;
      holdingRisks.push({
        market,
        symbol,
        account: id,
        quantity,
        price: bar.close,
        cost,
        stop: protection.stop,
        bar: bar.date,
        observedAt: now,
        sleeve,
      });
      exposure.push({
        market,
        sleeve,
        value: quantity * bar.close,
        at: data.completedAt(bar.date),
      });
      const strategy = systemWatch(
        `holding-${digest([id, protection])}`,
        market,
        symbol,
        sleeve,
      );
      const stateId = `holding:${strategy.id}`;
      const observation = holdingObservation(
        strategy,
        bar,
        protection,
        repo.state<HoldingWatchState>(stateId),
      );
      result.states.push({ id: stateId, value: observation.state });
      if (observation.trigger)
        propose(
          strategy,
          symbol,
          bar.date,
          observation.trigger,
          bar.close,
          "完成bar收盘穿越保护价；持续在线下不重复，回线上后下一bar再次跌破可再提醒",
          data.source,
          data.completedAt(bar.date),
          { stop: protection.stop, target: protection.target },
        );
    } catch (e) {
      exposureComplete = false;
      error(symbol, e);
    }
  };
  const protectionRepo = new HoldingProtectionRepository(repo.db);
  const bindings = protectionRepo.all().filter((b) => b.market === market);
  if (market === "cn-equity" && config.tdxRoot) {
    try {
      const positions = (await tradePositionState()).positions.filter(
        (p) => p.quantity > 0,
      );
      for (const p of positions) {
        if (
          bindings.some(
            (b) =>
              b.id ===
              protectionPositionKey("real", "手工账本", market, p.symbol),
          )
        )
          continue;
        const override = repo.state<HoldingProtection & { sleeve: string }>(
          `protection:cn-equity:${p.symbol}`,
        );
        await watchHolding(
          p.symbol,
          p.symbol,
          p.quantity,
          {
            stop: p.stop,
            target: override?.target ?? null,
            trailing: override?.trailing ?? null,
          },
          override?.sleeve ?? "swing",
          p.adjustedCost,
        );
      }
    } catch (e) {
      exposureComplete = false;
      error("holdings", e);
    }
  }
  const bots =
    market === "crypto"
      ? readRecordSnapshot("crypto-bot", (rows: Iterable<BotState>) => [
          ...rows,
        ])
      : [];
  for (const bot of bots)
    for (const [symbol, quantity] of Object.entries(bot.positions)) {
      if (Number(quantity) <= 0) continue;
      const protection = repo.state<HoldingProtection & { sleeve: string }>(
        `protection:crypto:${bot.id}:${symbol}`,
      );
      await watchHolding(
        `${bot.id}:${symbol}`,
        symbol,
        Number(quantity),
        protection ?? { stop: null, target: null, trailing: null },
        protection?.sleeve ?? "swing",
      );
    }
  if (
    bindings.length ||
    (market === "cn-equity" && new DeliveryStore(repo.db).fills().length)
  ) {
    try {
      const book = await loadAccountBook(
        new AccountWorkspaceRepository(repo.db),
        config,
        now,
      );
      for (const p of book.positions.filter(
        (p) =>
          p.market === market &&
          p.quantity > 0 &&
          (p.id.startsWith("delivery:") ||
            bindings.some(
              (b) =>
                b.id ===
                protectionPositionKey(p.kind, p.account, p.market, p.symbol),
            )),
      )) {
        const binding = bindings.find(
          (b) =>
            b.id ===
            protectionPositionKey(p.kind, p.account, p.market, p.symbol),
        );
        if (p.value === null) exposureComplete = false;
        let stop = p.stop,
          target: number | null = null;
        if (
          binding &&
          holdingProtectionCurrent(binding, book.trades) &&
          binding.protection.version === "plan-protection-1"
        ) {
          const period =
            repo.strategies.strategy(binding.strategyId, binding.version)
              ?.period ?? "day";
          const data = await series(p.symbol, period);
          const stateId = `holding-protection:${binding.id}`;
          const previous = repo.state<HoldingProtectionProjection>(stateId);
          // Only a complete close changes tomorrow's levels. Intraday checks use
          // the previously recommended standing order, never today's high.
          if (phase === "close" || market === "crypto") {
            const definition = repo.strategies.strategy(
              binding.strategyId,
              binding.version,
            )!;
            let ruleExit: boolean | null = binding.protection.exitSpec.rule
              ? null
              : false;
            let evidenceIssue: string | undefined;
            const last = data.bars.at(-1);
            if (
              !last ||
              (phase === "close" &&
                last.date.slice(0, 10) !== (closeDate ?? today))
            )
              evidenceIssue = "本次收盘日行情未完成，不推算新的保护价";
            if (
              market === "cn-equity" &&
              book.context
                .evidence(p.symbol)
                .events.some(
                  (e) =>
                    e.date >= binding.entryDate.slice(0, 10) &&
                    e.date <= (last?.date.slice(0, 10) ?? today),
                )
            )
              evidenceIssue =
                "持仓期间存在公司行动，券商保护价与股份到账需人工核验，不推算新保护价";
            if (
              p.reasons.some(
                (r) => r.includes("未认证除权") || r.includes("单位须"),
              )
            )
              evidenceIssue = "持仓股份或价格单位未获认证，不推算新保护价";
            if (binding.protection.exitSpec.rule && last) {
              try {
                ruleExit =
                  evaluateStrategySeries(
                    {
                      ...definition,
                      entry: { kind: "constant", value: false },
                      exit: binding.protection.exitSpec,
                    },
                    data,
                    last.date,
                  )?.decision.exit ?? null;
              } catch {
                evidenceIssue = "退出规则证据不可用；不能视为未触发";
              }
            }
            const projection = observeHoldingProtection(
              binding,
              data.rawBars,
              book.calendar,
              now,
              previous,
              { period, ruleExit, evidenceIssue },
            );
            result.states.push({
              id: stateId,
              value: projection,
              atCommit: (at) => ({ ...projection, observedAt: at }),
            });
            const snapshotKey = `protection-snapshot:${binding.id}:${binding.boundAt}:${projection.task.bar ?? "unavailable"}`;
            if (projection.task.bar && !repo.state(snapshotKey))
              result.states.push({
                id: snapshotKey,
                value: projection,
                atCommit: (at) => ({ ...projection, observedAt: at }),
              });
            stop = projection.backupStop;
          } else
            stop =
              previous?.bindingAt === binding.boundAt
                ? previous.task.newStop
                : binding.protection.initialStop;
          target = binding.protection.target;
        } else if (binding) {
          stop = null;
          error(p.symbol, new Error("Holding protection requires relinking"));
        }
        // The bot's original independent exposure is already accounted above.
        const botDuplicate =
          market === "crypto" &&
          bots.some(
            (b) =>
              b.id === p.account &&
              Object.entries(b.positions).some(
                ([symbol, quantity]) =>
                  symbol === p.symbol && Number(quantity) > 0,
              ),
          );
        if (!botDuplicate)
          await watchHolding(
            p.id,
            p.symbol,
            p.quantity,
            { stop, target, trailing: null },
            p.sleeve,
            p.cost,
          );
      }
    } catch (failure) {
      exposureComplete = false;
      error("holdings", failure);
    }
  }
  if (exposureComplete) {
    result.states.push({
      id: "holding-risk",
      value: [
        ...(repo.state<HoldingRiskSnapshot[]>("holding-risk") ?? []).filter(
          (h) => h.market !== market,
        ),
        ...holdingRisks,
      ],
    });
    const other = (repo.state<Exposure[]>("exposure") ?? []).filter(
      (e) => e.market !== market,
    );
    // Empty positions are a known zero; the marker also proves this market was checked.
    result.states.push({
      id: "exposure",
      value: [
        ...other,
        ...exposure,
        { market, sleeve: "__checked__", value: 0, at: now },
      ],
    });
    if (phase === "close")
      result.states.push({
        id: "exposure-close:cn-equity",
        value: [
          ...exposure,
          { market, sleeve: "__checked__", value: 0, at: now },
        ],
      });
    const capital = config.alerts.capital[market];
    for (const sleeve of config.alerts.sleeves.filter(
      (s) => s.market === market && capital > 0,
    )) {
      const actual =
        exposure
          .filter((e) => e.sleeve === sleeve.id)
          .reduce((n, e) => n + e.value, 0) / capital;
      const outside = Math.abs(actual - sleeve.share) >= 0.1;
      const key = `allocation:${market}:${sleeve.id}`;
      const previous = repo.state<boolean>(key);
      result.states.push({ id: key, value: outside });
      if (outside && previous !== true) {
        const strategy = systemWatch(
          `allocation-${market}-${sleeve.id}`,
          market,
          `sleeve:${sleeve.id}`,
          sleeve.id,
        );
        propose(
          strategy,
          `sleeve:${sleeve.id}`,
          new Date(now).toISOString(),
          "allocation",
          null,
          `分仓市值/配置总资金=${displayNumber(actual * 100, 2)}%，目标${displayNumber(sleeve.share * 100, 2)}%；偏离至少10个百分点。持仓默认归swing，可显式分配`,
          "本地持仓与用户配置资金；不含未登记外部持仓",
          now,
        );
      }
    }
  }
  for (const plan of repo
    .plans(true)
    .filter(
      (p) =>
        p.market === market ||
        (!p.market &&
          repo.strategies.strategy(p.strategyId, p.strategyVersion)?.market ===
            market),
    )) {
    if (plan.expiresAt && Date.parse(plan.expiresAt) <= now) continue;
    try {
      const data = await series(plan.symbol, phase === "close" ? "day" : "5m");
      const bar = data.bars.at(-1);
      if (
        !bar ||
        (plan.createdAt && data.completedAt(bar.date) <= plan.createdAt)
      )
        continue;
      const stages = plan.stages ?? [
        { entry: plan.entry, quantity: plan.quantity ?? 0 },
      ];
      const triggered = repo.state<number[]>(`plan-stages:${plan.id}`) ?? [];
      const next = [...triggered];
      for (const [i, stage] of stages.entries()) {
        if (next.includes(i) || bar.close < stage.entry) continue;
        next.push(i);
        const strategy = systemWatch(
          `plan-stage-${digest([plan.id, i])}`,
          market,
          plan.symbol,
          plan.sleeve,
        );
        propose(
          strategy,
          plan.symbol,
          bar.date,
          "plan-entry",
          bar.close,
          `计划${plan.id}第${i + 1}档收盘达到${stage.entry}，参考数量${stage.quantity}；须人工核对，不下单`,
          data.source,
          data.completedAt(bar.date),
          { planId: plan.id, stop: plan.stop, target: plan.target },
        );
        result.proposals.at(-1)!.authorize = () =>
          repo.strategies.plan(plan.id)?.status === "open";
        if (next.length === stages.length)
          result.proposals.at(-1)!.closePlan = "triggered";
      }
      result.states.push({ id: `plan-stages:${plan.id}`, value: next });
    } catch (e) {
      error(plan.symbol, e);
    }
  }
  const regimeEnabled =
    market === "cn-equity"
      ? phase === "close" && !!config.tdxRoot
      : strategies.length > 0 ||
        bots.length > 0 ||
        repo.subscriptions().some((s) => s.enabled && s.market === "crypto");
  if (regimeEnabled)
    for (const symbol of market === "crypto"
      ? ["BTCUSDT", "ETHUSDT"]
      : ["sh000300", "sz399006"]) {
      try {
        const data = await series(symbol, market === "crypto" ? "4h" : "day");
        const bar = data.bars.at(-1);
        const regime = regimeObservation(data.bars);
        if (!regime || !bar) continue;
        const key = `regime:${market}:${symbol}`;
        const previous = repo.state<ReturnType<typeof regimeObservation>>(key);
        result.states.push({
          id: key,
          value: {
            ...regime,
            bar: bar.date,
            source: data.source,
            observedAt: now,
            ...(market === "cn-equity"
              ? { low: historicalLowSeries(data.bars).at(-1) }
              : {}),
          },
        });
        if (
          previous &&
          (previous.trend !== regime.trend || previous.zone !== regime.zone)
        ) {
          const strategy = systemWatch(
            `regime-${market}-${symbol}`,
            market,
            symbol,
          );
          propose(
            strategy,
            symbol,
            bar.date,
            "regime",
            bar.close,
            `${previous.trend}/${previous.zone} → ${regime.trend}/${regime.zone}，温度${displayNumber(regime.temperature, 1)}；${regime.basis}`,
            data.source,
            data.completedAt(bar.date),
          );
        }
      } catch (e) {
        error(symbol, e);
      }
    }
  return result;
}
