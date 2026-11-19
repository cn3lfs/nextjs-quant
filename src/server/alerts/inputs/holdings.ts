import { usesStrategyBook, strategyObjectSchema } from "trading-strategies";
import { isDeepStrictEqual } from "node:util";
import { type HoldingRiskSnapshot } from "../workspace";
import {
  holdingObservation,
  type HoldingProtection,
  type HoldingWatchState,
} from "../observations";
import { HoldingProtectionRepository } from "../../db/holding-protection-repository";
import { AccountWorkspaceRepository } from "../../db/account-workspace-repository";
import { DeliveryStore } from "../../db/delivery-store";
import { loadAccountBook } from "../../portfolio/account-workspace-service";
import {
  holdingProtectionCurrent,
  observeHoldingProtection,
  protectionPositionKey,
  type HoldingProtectionProjection,
} from "~/lib/portfolio/holding-protection";
import { tradePositionState } from "../../portfolio/trade-ledger-service";
import { evaluateStrategySeries } from "../../strategies/drivers/evaluation";
import { systemWatch, digest, type AlertInputContext } from "./context";
import { readCryptoBots, watchCryptoHoldings } from "./crypto-holdings";

export type Exposure = {
  market: "cn-equity" | "crypto";
  sleeve: string;
  value: number;
  at: number;
};
export async function evaluateHoldingInputs(ctx: AlertInputContext) {
  const {
    phase,
    now,
    repo,
    closeDate,
    config,
    market,
    today,
    result,
    series,
    error,
    validity,
    propose,
    frozenPaperSeries,
  } = ctx;
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
  const bots = readCryptoBots(market);
  await watchCryptoHoldings(repo, bots, watchHolding);
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
            const nativeExit =
              !!definition &&
              (usesStrategyBook(definition) || !!definition.exit.chandelier);
            let ruleExit: boolean | null = binding.protection.exitSpec.rule
              ? null
              : false;
            let evidenceIssue: string | undefined;
            let chandelierStop: number | null | undefined;
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
            if (
              (nativeExit ||
                binding.protection.exitSpec.rule ||
                binding.protection.exitSpec.chandelier) &&
              last
            ) {
              try {
                const native = nativeExit;
                if (
                  native &&
                  !isDeepStrictEqual(
                    binding.protection.exitSpec,
                    strategyObjectSchema.parse(definition).exit,
                  )
                )
                  throw new Error(
                    "人工退出规则与同版本冻结策略不同；需重新核验，保留既有保护价",
                  );
                const genuine = native
                  ? frozenPaperSeries(
                      definition,
                      p.symbol,
                      last.date,
                      data.rawBars.find((bar) => bar.date === last.date),
                    ).series
                  : null;
                const evaluated = evaluateStrategySeries(
                  native
                    ? definition
                    : {
                        ...definition,
                        entry: { kind: "constant", value: false },
                        exit: binding.protection.exitSpec,
                      },
                  genuine ?? data,
                  last.date,
                );
                ruleExit = evaluated?.decision.exit ?? null;
                chandelierStop = evaluated?.decision.chandelierStop;
              } catch (failure) {
                evidenceIssue ??=
                  failure instanceof Error
                    ? failure.message
                    : "退出规则证据不可用；不能视为未触发";
              }
            }
            const projection = observeHoldingProtection(
              binding,
              data.rawBars,
              book.calendar,
              now,
              previous,
              { period, ruleExit, evidenceIssue, chandelierStop },
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
  return { exposure, holdingRisks, exposureComplete, hasBots: bots.length > 0 };
}

export type HoldingInputs = Awaited<ReturnType<typeof evaluateHoldingInputs>>;
