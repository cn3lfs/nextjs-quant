import { createHash } from "node:crypto";
import { z } from "zod";
import {
  strategyObjectSchema,
  type StrategyObjectInput,
} from "trading-strategies";
import type { PortfolioRequest, PortfolioFill } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import { cryptoPeriodMs } from "~/lib/market/crypto-aggregation";
import { beijingClock } from "~/lib/market/market-session";
import { forwardDefinitionHash } from "../db/forward-reference-repository";
import {
  AccountWorkspaceRepository,
  type AccountExpectation,
} from "../db/account-workspace-repository";
import { AccountReviewRepository } from "../db/account-review-repository";
import { AlertRepository } from "../db/alert-repository";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
type CohortSource = {
  expectation: AccountExpectation;
  definitionHash: string;
  inputHash: string;
  resultHash: string;
  buildHash: string;
  actionCoverage?: PublishAccountExpectation["actionCoverage"];
};
export type PublishAccountExpectation = {
  strategy: StrategyObjectInput;
  request: PortfolioRequest;
  fills: readonly Pick<
    PortfolioFill,
    "strategyId" | "symbol" | "date" | "side" | "price"
  >[];
  inputHash: string;
  resultHash: string;
  buildHash: string;
  source: string;
  limitations?: string[];
  actionCoverage?: Readonly<
    Record<
      string,
      { from: string; through: string; source: string; hash: string }
    >
  >;
};

/** Derive the fixed twenty-market-day entry cohort from actual frozen fills and
 * raw closes. It is selection attribution, not the L4 trade-return distribution. */
export function publishAccountExpectation(
  input: PublishAccountExpectation,
  repo = new AccountWorkspaceRepository(),
) {
  const strategy = strategyObjectSchema.parse(input.strategy);
  if (!input.source.trim()) throw new Error("期望缺少来源说明");
  for (const value of [input.inputHash, input.resultHash, input.buildHash])
    hash.parse(value);
  const known = input.request.strategies.find(
    (s) => s.id === strategy.id && s.version === strategy.version,
  );
  if (
    !known ||
    forwardDefinitionHash(known) !== forwardDefinitionHash(strategy)
  )
    throw new Error("期望来源与策略版本或定义不一致");
  const daily = new Map<string, Map<string, Bar>>();
  for (const instrument of input.request.instruments) {
    const days = new Map<string, Bar>();
    for (const bar of instrument.bars) {
      let date: string | null = null;
      if (bar.date.length === 10 && strategy.period === "day") date = bar.date;
      else if (
        strategy.market === "crypto" &&
        Date.parse(bar.date) % 86400000 === 0
      )
        date = new Date(Date.parse(bar.date) - 1).toISOString().slice(0, 10);
      else if (
        strategy.market === "cn-equity" &&
        bar.date.includes("T") &&
        beijingClock(Date.parse(bar.date)).hhmm === "15:00"
      )
        date = beijingClock(Date.parse(bar.date)).date;
      if (date) {
        if (days.has(date)) throw new Error("期望来源含重复日收盘");
        days.set(date, bar);
      }
    }
    daily.set(instrument.symbol, days);
  }
  let calendar = [
    ...new Set(input.request.calendar.map((d) => d.slice(0, 10))),
  ].sort();
  if (strategy.market === "crypto" && calendar.length) {
    const first = Date.parse(calendar[0]!),
      last = Date.parse(calendar.at(-1)!);
    calendar = Array.from(
      { length: Math.floor((last - first) / 86400000) + 1 },
      (_, i) => new Date(first + i * 86400000).toISOString().slice(0, 10),
    );
  }
  const buys = input.fills.filter(
    (f) => f.strategyId === strategy.id && f.side === "buy",
  );
  const samples: number[] = [];
  for (const fill of buys) {
    let date = fill.date.slice(0, 10);
    if (strategy.market === "crypto" && fill.date.includes("T"))
      date = new Date(
        Date.parse(fill.date) - (cryptoPeriodMs[strategy.period] ?? 0),
      )
        .toISOString()
        .slice(0, 10);
    const index = calendar.indexOf(date),
      end = calendar[index + 19],
      stock = input.request.instruments.find((i) => i.symbol === fill.symbol);
    if (index < 0 || !end || !stock || !(fill.price > 0)) continue;
    const coverage = input.actionCoverage?.[fill.symbol];
    if (
      strategy.market === "cn-equity" &&
      (!coverage ||
        coverage.from > date ||
        coverage.through < end ||
        !coverage.source.trim() ||
        !hash.safeParse(coverage.hash).success ||
        !stock.actions ||
        stock.actions.some((a) => a.date > date && a.date <= end))
    )
      continue;
    const close = daily.get(fill.symbol)?.get(end)?.close;
    if (close !== undefined && Number.isFinite(close) && close > 0)
      samples.push(close / fill.price - 1);
  }
  const definitionHash = forwardDefinitionHash(strategy);
  const expectation: AccountExpectation = {
    strategyId: strategy.id,
    version: strategy.version,
    strategyHash: digest(strategy),
    definitionHash,
    inputHash: input.inputHash,
    resultHash: input.resultHash,
    buildHash: input.buildHash,
    source: input.source,
    horizon: 20,
    basis: "raw-entry-20-close",
    samples,
    excluded: buys.length - samples.length,
    capturedAt: Date.now(),
    limitations: [
      ...(input.limitations ?? []),
      "二十市场日原价入场选择归因，非策略净收益；缺日收盘/带来源哈希的公司行动覆盖截止证据不补造，空actions列表不视为覆盖证明",
    ],
  };
  const source: CohortSource = {
    expectation,
    definitionHash,
    inputHash: input.inputHash,
    resultHash: input.resultHash,
    buildHash: input.buildHash,
    ...(input.actionCoverage ? { actionCoverage: input.actionCoverage } : {}),
  };
  const store = new AccountReviewRepository(repo.db).records;
  const id = `account-expectation-source:${definitionHash}:${input.inputHash}:${input.resultHash}`;
  const previous = store.read<CohortSource>(id);
  if (previous) {
    if (
      digest({ ...previous.expectation, capturedAt: 0 }) !==
        digest({ ...expectation, capturedAt: 0 }) ||
      digest(previous.actionCoverage ?? null) !==
        digest(source.actionCoverage ?? null)
    )
      throw new Error("同来源的期望分布发生冲突");
  } else store.save("account-expectation-source", id, source);
  if (
    new AlertRepository(repo.db).strategies.strategy(
      strategy.id,
      strategy.version,
    )
  )
    freezeMatchingAccountExpectation(strategy.id, strategy.version, repo);
  return previous?.expectation ?? expectation;
}

export type AccountExpectationAnchor = {
  inputHash: string;
  resultHash?: string;
  buildHash?: string;
};
export function freezeMatchingAccountExpectation(
  id: string,
  version: number,
  repo = new AccountWorkspaceRepository(),
  anchor?: AccountExpectationAnchor,
) {
  const alerts = new AlertRepository(repo.db),
    strategy = alerts.strategies.strategy(id, version);
  if (!strategy) throw new Error("期望冻结缺少策略定义");
  const definitionHash = forwardDefinitionHash(strategy),
    records = new AccountReviewRepository(repo.db).records;
  const status = (reason: string) => {
    const prior = records.read<{
      status: string;
      definitionHash: string;
      reason: string;
    }>(`account-expectation-status:${id}:${version}`);
    if (
      prior?.status === "unavailable" &&
      prior.definitionHash === definitionHash &&
      prior.reason === reason
    )
      return { status: "unavailable" as const, expectation: null, reason };
    records.save(
      "account-expectation-status",
      `account-expectation-status:${id}:${version}`,
      { status: "unavailable", definitionHash, reason, at: Date.now() },
    );
    return { status: "unavailable" as const, expectation: null, reason };
  };
  const stored = records.read<
    AccountExpectationAnchor & { definitionHash: string }
  >(`account-expectation-anchor:${id}:${version}`);
  const qualification = alerts.records.read<{ inputHash?: string }>(
    `strategy-qualification-${id}`,
  );
  const selected =
    anchor ??
    stored ??
    (qualification?.inputHash ? { inputHash: qualification.inputHash } : null);
  if (!selected || !hash.safeParse(selected.inputHash).success)
    return status(
      "登记未选择validation run/inputHash，不能任择同定义的历史来源",
    );
  if (
    stored &&
    (stored.definitionHash !== definitionHash ||
      stored.inputHash !== selected.inputHash ||
      (anchor?.resultHash &&
        stored.resultHash &&
        anchor.resultHash !== stored.resultHash))
  )
    throw new Error(
      "该版本已绑定另一验证来源，请用新版本明确切换，不覆盖历史期望",
    );
  if (anchor && !stored) {
    hash.parse(anchor.inputHash);
    if (anchor.resultHash) hash.parse(anchor.resultHash);
    if (anchor.buildHash) hash.parse(anchor.buildHash);
    records.save(
      "account-expectation-anchor",
      `account-expectation-anchor:${id}:${version}`,
      { ...anchor, definitionHash },
    );
  }
  const existing = repo.expectation(id, version);
  if (existing) {
    if (
      existing.definitionHash
        ? existing.definitionHash !== definitionHash
        : existing.strategyHash !== digest(strategy)
    )
      throw new Error("已冻结期望与当前策略定义不符");
    if (
      existing.inputHash !== selected.inputHash ||
      (selected.resultHash && existing.resultHash !== selected.resultHash) ||
      (selected.buildHash && existing.buildHash !== selected.buildHash)
    )
      return status(
        "历史冻结期望未匹配本次所选来源锚；保留原记录，不冒称同一验证",
      );
    const prior = records.read<{ status: string; definitionHash: string }>(
      `account-expectation-status:${id}:${version}`,
    );
    if (prior?.status !== "frozen" || prior.definitionHash !== definitionHash)
      records.save(
        "account-expectation-status",
        `account-expectation-status:${id}:${version}`,
        {
          status: "frozen",
          definitionHash,
          source: existing.source,
          at: Date.now(),
        },
      );
    return { status: "frozen" as const, expectation: existing, reason: null };
  }
  const sources = records
    .all<CohortSource>("account-expectation-source")
    .filter(
      (s) =>
        s.definitionHash === definitionHash &&
        s.expectation.strategyId === id &&
        s.expectation.version === version &&
        s.inputHash === selected.inputHash &&
        (!selected.resultHash || s.resultHash === selected.resultHash) &&
        (!selected.buildHash || s.buildHash === selected.buildHash),
    );
  if (sources.length > 1)
    return status(
      "所选inputHash匹配多个结果/构建，缺少唯一resultHash/buildHash锚，不任意挑选",
    );
  const source = sources[0];
  if (source) {
    if (!source.expectation.samples.length)
      return status(
        `所选来源有${source.expectation.excluded}个入场被排除，缺少完整20日收盘或公司行动覆盖证据，不冻结空分布`,
      );
    const expectation = repo.atomic(() =>
      repo.freezeExpectation(source.expectation),
    );
    records.save(
      "account-expectation-status",
      `account-expectation-status:${id}:${version}`,
      {
        status: "frozen",
        definitionHash,
        source: expectation.source,
        at: Date.now(),
      },
    );
    return { status: "frozen" as const, expectation, reason: null };
  }
  const jobs = new AccountReviewRepository(repo.db).completedValidationJobs(
    id,
    version,
  );
  const matches: {
    jobId: string;
    value: {
      inputHash: string;
      frozen: {
        request: PortfolioRequest;
        executionBuildHash: string;
        actionCoverage?: PublishAccountExpectation["actionCoverage"];
      };
      result: { fills: PortfolioFill[] };
    };
  }[] = [];
  for (const { id: jobId, job } of jobs) {
    const value = job.result as {
      inputHash?: string;
      frozen?: {
        request?: PortfolioRequest;
        executionBuildHash?: string;
        actionCoverage?: PublishAccountExpectation["actionCoverage"];
      };
      result?: { fills?: PortfolioFill[] };
    };
    if (
      !value.frozen?.request ||
      !value.result?.fills ||
      value.inputHash !== selected.inputHash ||
      !hash.safeParse(value.frozen.executionBuildHash).success
    )
      continue;
    if (digest(value.frozen) !== value.inputHash)
      throw new Error("自动期望来源冻结输入哈希不符");
    if (
      (selected.resultHash && selected.resultHash !== digest(value.result)) ||
      (selected.buildHash &&
        selected.buildHash !== value.frozen.executionBuildHash)
    )
      continue;
    matches.push({ jobId, value: value as (typeof matches)[number]["value"] });
  }
  if (
    new Set(
      matches.map(
        ({ value }) =>
          `${digest(value.result)}:${value.frozen.executionBuildHash}`,
      ),
    ).size > 1
  )
    return status(
      "所选inputHash匹配多个真实验证结果，缺少唯一resultHash/buildHash锚",
    );
  const match = matches[0];
  if (match) {
    const { jobId, value } = match;
    publishAccountExpectation(
      {
        strategy,
        request: value.frozen.request,
        fills: value.result.fills,
        inputHash: value.inputHash,
        resultHash: digest(value.result),
        buildHash: value.frozen.executionBuildHash!,
        source: `job:${jobId}:${value.inputHash}`,
        actionCoverage: value.frozen.actionCoverage,
      },
      repo,
    );
    return freezeMatchingAccountExpectation(id, version, repo, selected);
  }
  return status(
    "所选验证尚无同定义及完整来源哈希的真实成交/原价二十日分布；不从窗口汇总补造",
  );
}
