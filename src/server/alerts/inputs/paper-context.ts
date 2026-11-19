import {
  strategyObjectSchema,
  type StrategyObjectInput,
} from "trading-strategies";
import { isDeepStrictEqual } from "node:util";
import { AlertRepository } from "../../db/alert-repository";
import { type Bar } from "~/lib/domain";
import { PaperRepository } from "../../db/paper-repository";

export function createPaperContext(repo: AlertRepository) {
  const paperRepo = new PaperRepository(repo.db);
  const paperContexts = new Map<
    string,
    ReturnType<PaperRepository["watchContext"]>
  >();
  const paperAccounts = paperRepo.ids().map((id) => paperRepo.account(id)!);
  const matchingPaperAccounts = (strategy: StrategyObjectInput) =>
    paperAccounts.filter((account) =>
      account.candidates.some(
        (candidate) =>
          candidate.strategy.id === strategy.id &&
          candidate.strategy.version === strategy.version,
      ),
    );
  const frozenPaperSeries = (
    strategy: StrategyObjectInput,
    symbol: string,
    date: string,
    quote: Bar | undefined,
  ) => {
    const accounts = matchingPaperAccounts(strategy);
    if (accounts.length !== 1)
      throw new Error(
        accounts.length
          ? "同版本纸面来源账户不唯一；不能任取一个退出或入场依据"
          : "缺同版本纸面账户的冻结策略输入",
      );
    const contextKey = `${accounts[0]!.id}:${date}`;
    if (!paperContexts.has(contextKey))
      paperContexts.set(
        contextKey,
        paperRepo.watchContext(accounts[0]!.id, date),
      );
    const context = paperContexts.get(contextKey);
    const definition = context?.strategies.find(
      (row) => row.id === strategy.id && row.version === strategy.version,
    );
    const frozen = context?.instruments.get(symbol);
    if (
      !context ||
      !definition ||
      !isDeepStrictEqual(
        strategyObjectSchema.parse(definition),
        strategyObjectSchema.parse(strategy),
      ) ||
      frozen?.market !== strategy.market ||
      frozen.bars.at(-1)?.date !== date ||
      frozen.rawBars.at(-1)?.date !== date ||
      (strategy.market === "cn-equity" &&
        !frozen.external.preparedRules?.some(
          (rule) =>
            rule.strategy.id === strategy.id &&
            rule.points.some((point) => point.date === date),
        ))
    )
      throw new Error(
        "缺同版本同完成bar的纸面固定基准与真实规则证据；等待同日记账",
      );
    if (!quote || !isDeepStrictEqual(quote, frozen.rawBars.at(-1)))
      throw new Error("原价与同bar纸面冻结原价不一致；拒绝重解释信号");
    return { context, series: { ...frozen, source: context.source } };
  };
  return { paperRepo, matchingPaperAccounts, frozenPaperSeries };
}
