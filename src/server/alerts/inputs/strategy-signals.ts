import {
  classifiedMonitorObservations,
  usesStrategyBook,
  type StrategyExternalInputs,
} from "trading-strategies";
import { get } from "../../db";
import { RpsStore } from "../../db/rps-store";
import { cryptoSymbol, isCryptoSymbol } from "~/lib/market/crypto";
import {
  type SecurityTradingStatus,
  currentTradingStatus,
} from "~/lib/market/security-trading-status";
import { watchStrategy } from "../../strategies/drivers/watch";
import { captureNativeChanObservations } from "../../strategies/strategy-center-native";
import { analyzeCzsc } from "../../strategies/chan/czsc";
import { candidateScanWatermark } from "../candidate-scan";
import {
  appendShadowSamples,
  assessShadow,
  shadowBarCompletedAt,
  type ShadowRegistration,
  type ShadowProgress,
  type ShadowSample,
} from "../shadow";
import { evaluateStrategySeries } from "../../strategies/drivers/evaluation";
import { corporateActions } from "../../market/bar-store/corporate-actions";
import { researchCorporateActions } from "../../research/corporate-actions";
import { strategyDecisionReason } from "~/lib/strategy-facts/decision-reason";
import { type DriverBookAdmission } from "../../strategies/drivers/book";
import { type AlertInputContext } from "./context";
import { readEntryTradingStatus } from "./cn-trading-status";

export async function evaluateStrategyInputs(ctx: AlertInputContext) {
  const {
    phase,
    now,
    repo,
    closeDate,
    config,
    market,
    result,
    series,
    error,
    validity,
    propose,
    paperRepo,
    matchingPaperAccounts,
    frozenPaperSeries,
  } = ctx;
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
    const paper = usesStrategyBook(strategy) ? paperRepo : null;
    const strategyAccounts = paper ? matchingPaperAccounts(strategy) : [];
    const paperUniverse = strategyAccounts.flatMap((account) =>
      account.candidates.flatMap((candidate) =>
        candidate.strategy.id === strategy.id &&
        candidate.strategy.version === strategy.version
          ? (candidate.sourceContext?.universeSymbols ?? [])
          : [],
      ),
    );
    const bookByBar = new Map<string, DriverBookAdmission>();
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
        : paperUniverse.length
          ? paperUniverse
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
        let data = await series(symbol, strategy.period, !paper);
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
        let external: StrategyExternalInputs = {};
        const rules = [strategy.entry, strategy.exit?.rule].filter((r) => !!r);
        if (
          !paper &&
          (rules.some((r) => r.kind === "rps" || r.kind === "formula") ||
            strategy.universe.kind === "rps")
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
        if (!paper && native?.kind === "chan-third-buy")
          external.chan = (
            await captureNativeChanObservations(data.bars, native.firstIndex)
          ).observations;
        const monitor = rules.find((r) => r.kind === "czsc-monitor");
        if (!paper && monitor?.kind === "czsc-monitor") {
          const nativeResult = await analyzeCzsc(
            data.bars,
            true,
            undefined,
            true,
            1,
          );
          const key = `native:${strategy.id}:${strategy.version}:${symbol}`;
          const observations = classifiedMonitorObservations(
            nativeResult,
            data.bars,
            data.bars.length - 1,
          );
          external.monitorCzsc = {
            observations,
            result: nativeResult,
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
        let admission: DriverBookAdmission | undefined;
        let membership: readonly string[] = symbols;
        if (paper) {
          const { context, series: frozen } = frozenPaperSeries(
            strategy,
            symbol,
            bar.date,
            data.rawBars.find((row) => row.date === bar.date),
          );
          external = frozen.external;
          data = { ...data, ...frozen };
          const frozenMembership = context.memberships.find(
            (row) => row.strategyId === strategy.id,
          );
          if (
            strategy.universe.kind === "pool" ||
            strategy.universe.kind === "index" ||
            strategy.universe.kind === "all-market"
          ) {
            if (!frozenMembership) throw new Error("缺同bar纸面冻结证券池资格");
            membership = frozenMembership.symbols;
          }
          admission = bookByBar.get(bar.date);
          if (!admission) {
            const matches = context.decisions.filter(
              (row) => row.strategyId === strategy.id,
            );
            const decision = matches.length === 1 ? matches[0]!.decision : null;
            if (!decision)
              throw new Error(
                "缺同版本同完成bar的完整组合决策；等待纸面账户完成同日记账",
              );
            admission = {
              strategyId: strategy.id,
              version: strategy.version,
              decision,
            };
            bookByBar.set(bar.date, admission);
          }
        }
        const events = watchStrategy(
          strategy,
          { ...data, external },
          bar.date,
          { membership, admission },
        );
        const ruleEvidence = events.length
          ? evaluateStrategySeries(strategy, { ...data, external }, bar.date)
              ?.evidence
          : undefined;
        const allocation = admission?.decision.entries.find(
            (e) => e.symbol === symbol,
          ),
          adjustment = admission?.decision.adjustments?.find(
            (a) => a.symbol === symbol,
          );
        const why = strategyDecisionReason(
          ruleEvidence && allocation?.rps
            ? { ...ruleEvidence, rps: allocation.rps }
            : ruleEvidence,
          {
            rankScore: allocation?.score,
            regime: admission?.decision.regime
              ? {
                  ...admission.decision.regime,
                  effect: admission.decision.regimeEffect,
                }
              : null,
            targetWeight: allocation?.weight ?? adjustment?.targetWeight,
            currentWeight:
              allocation?.currentWeight ?? adjustment?.currentWeight,
            deltaWeight: allocation?.deltaWeight ?? adjustment?.deltaWeight,
            marketLowZone: admission?.decision.marketLowZone,
          },
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
            status = await readEntryTradingStatus(symbol, now);
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
            `${phase === "close" ? "收盘扫描：明日计划候选" : "已完成bar策略触发"}；${market === "cn-equity" ? "策略复权条件：" : ""}${why}；完成bar ${event.bar}，原价${event.price}，止损=${event.stop ?? "无"}，目标=${event.target ?? "无"}${statusUnknown ? "；交易状态未知，请核验；仅影子记录" : ""}`,
            data.source,
            data.completedAt(bar.date),
            {
              stop: event.stop,
              target: event.target,
              ...(strategy.rank &&
              event.rankScore !== undefined &&
              Number.isFinite(event.rankScore)
                ? { rankScore: event.rankScore }
                : {}),
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
  return strategies.length > 0;
}
