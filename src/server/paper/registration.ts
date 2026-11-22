import { randomUUID } from "node:crypto";
import { strategyObjectSchema, usesStrategyBook } from "trading-strategies";
import { marketRules } from "trading-strategy-core/market-rules";
import { z } from "zod";
import frozen from "../data/paper-candidates.json";
import { PaperRepository } from "../db/paper-repository";
import { AlertRepository } from "../db/alert-repository";
import { selectShadowCandidates } from "../research/shadow-selection";
import { ForwardReferenceRepository } from "../db/forward-reference-repository";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { freezeMatchingAccountExpectation } from "../portfolio/account-expectation-service";
import type { ScoreboardRow } from "../research/validation-model";
import { readLifecycleCandidateSource } from "../research/lifecycle-candidate";
import { isDeepStrictEqual } from "node:util";
import {
  paperSettingsSchema,
  type FrozenCandidate,
  type PaperAccount,
} from "./model";
import { paperSleevePolicy } from "./policy";

export const registerPaperAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    market: z.enum(["cn-equity", "crypto"]),
    currency: z.enum(["CNY", "USDT"]),
    sleeve: z.string().trim().min(1),
    initial: z.number().finite().positive().max(1e9),
    candidates: z.array(strategyObjectSchema).min(1),
  })
  .strict();

function createPaperAccount(
  repo: PaperRepository,
  input: Pick<
    PaperAccount,
    "id" | "name" | "market" | "currency" | "sleeve" | "initial" | "candidates"
  >,
  now: number,
) {
  const account: PaperAccount = {
    ...input,
    startedAt: now,
    mirror: { venue: "off" },
    mirrorRevision: randomUUID(),
    revision: 0,
    lastBar: null,
    lastRun: null,
    error: null,
    summary: null,
  };
  if (!repo.create(account)) throw new Error("纸面账户已存在");
  const references = new ForwardReferenceRepository(repo.db);
  const expectations = new AccountWorkspaceRepository(repo.db);
  for (const { strategy } of account.candidates) {
    references.bindPaper(account.id, strategy, now);
    const reference = references.paper(account.id, strategy, now);
    freezeMatchingAccountExpectation(
      strategy.id,
      strategy.version,
      expectations,
      reference
        ? {
            inputHash: reference.identity.inputHash,
            resultHash: reference.resultHash,
            buildHash: reference.identity.buildHash,
          }
        : undefined,
    );
  }
  return account;
}

/** A prospective paper account created only by an explicit request. */
export function registerPaperAccount(
  raw: unknown,
  repo = new PaperRepository(),
  now = Date.now(),
) {
  const { candidates, ...input } = registerPaperAccountSchema.parse(raw);
  if (input.currency !== (input.market === "crypto" ? "USDT" : "CNY"))
    throw new Error("纸面账户币种与市场不符");
  const ids = new Set<string>();
  const period = candidates[0]!.period;
  for (const strategy of candidates) {
    if (ids.has(strategy.id))
      throw new Error(
        `纸面候选策略 id 重复（${strategy.id}）；同一账户只能使用一个版本`,
      );
    ids.add(strategy.id);
    if (strategy.market !== input.market || strategy.sleeve !== input.sleeve)
      throw new Error(`纸面候选市场或 sleeve 与账户不符（${strategy.id}）`);
    if (strategy.period !== period)
      throw new Error("合账候选须使用同一原生周期");
  }
  return repo.atomic(() => {
    const existing = repo.ids().map((id) => repo.account(id)!);
    if (
      existing.some(
        (account) => account.name?.toLowerCase() === input.name.toLowerCase(),
      )
    )
      throw new Error(`纸面账户名称已存在（${input.name}）`);
    for (const strategy of candidates)
      if (
        existing.some((account) =>
          account.candidates.some(
            (candidate) =>
              candidate.strategy.id === strategy.id &&
              candidate.strategy.version === strategy.version,
          ),
        )
      )
        throw new Error(
          `纸面候选策略已登记（${strategy.id}:v${strategy.version}）`,
        );

    const alerts = new AlertRepository(repo.db);
    const native = candidates.some(
      (strategy) =>
        usesStrategyBook(strategy) ||
        !!strategy.exit.chandelier ||
        !!strategy.exit.timeReentry,
    );
    const symbols = new Set(
      candidates.flatMap((strategy) =>
        strategy.universe.kind === "symbols" ? strategy.universe.symbols : [],
      ),
    );
    for (const symbol of symbols) {
      const valid =
        input.market === "cn-equity"
          ? /^(sh|sz|bj)\d{6}$/.test(symbol)
          : /^(?:cx)?(BTCUSDT|ETHUSDT)$/i.test(symbol);
      if (!valid) throw new Error(`纸面候选证券代码与市场不符（${symbol}）`);
    }
    const policy = {
      initial: input.initial,
      sleeves: [paperSleevePolicy(input.market, input.sleeve, symbols.size)],
      costs: marketRules[input.market].costs ?? undefined,
    };
    const rows = candidates.map((strategy): FrozenCandidate => {
      const lifecycle = readLifecycleCandidateSource(strategy, alerts);
      if (native && strategy.id.startsWith("l3-") && !lifecycle)
        throw new Error(`L3 纸面候选缺少同版本冻结来源（${strategy.id}）`);
      if (
        strategy.universe.kind !== "symbols" &&
        !(native && lifecycle?.sourceContext.universeSymbols.length)
      )
        throw new Error(`纸面候选缺少冻结证券池（${strategy.id}）`);
      if (
        lifecycle &&
        (candidates.length !== 1 ||
          lifecycle.executionPolicy.initial !== input.initial ||
          !isDeepStrictEqual(
            lifecycle.executionPolicy.sleeves.map((s) => s.id),
            [input.sleeve],
          ))
      )
        throw new Error("纸面账户本金或合账方式与同版本冻结执行政策不符");
      alerts.strategies.saveStrategy(strategy);
      return {
        strategy,
        ...(native
          ? { executionPolicy: lifecycle?.executionPolicy ?? policy }
          : {}),
        ...(lifecycle ? { sourceContext: lifecycle.sourceContext } : {}),
        row: lifecycle?.row ?? unreviewedCandidateRow(strategy, "research"),
        registration: inactivePaperRegistration,
        expectation: { windows: [], holdout: null },
      };
    });
    return createPaperAccount(
      repo,
      { ...input, id: `paper:${randomUUID()}`, candidates: rows },
      now,
    );
  });
}

const inactivePaperRegistration: FrozenCandidate["registration"] = {
  status: "shadow-candidate",
  active: false,
  trialSharpes: [],
  neighbors: [],
  sizing: "legacy",
  completeMarketCycles: 0,
  lowZoneCorroborated: false,
};

function unreviewedCandidateRow(
  strategy: FrozenCandidate["strategy"],
  status: ScoreboardRow["status"],
  reasons = ["backtest-gates-not-passed"],
): ScoreboardRow {
  return {
    id: strategy.id,
    level: "strategy",
    market: strategy.market,
    sleeve: strategy.sleeve,
    rule: strategy.entry.kind,
    status,
    reasons,
    return: null,
    drawdown: null,
    excess: null,
    trades: 0,
    oosWindows: 0,
    positiveWindows: 0,
    bias: {
      universe: "当前登记证券池；历史覆盖未提供",
      adjustment: "随实际BarStore输入冻结",
      financial: "未提供该候选冻结研究证据",
      execution: "模拟；不认证可投资业绩",
    },
  };
}

export type RegisterPaperCandidatesOptions = {
  /** Test-only escape hatch for the retired frozen r2a-* fixtures. */
  allowLegacyFixtures?: boolean;
};

/**
 * The five hardcoded paper-candidates.json accounts are retired. Production
 * ticks, settings saves and UI refreshes must never resurrect them; only an
 * explicit test opt-in (or Vitest) may seed the frozen fixtures.
 */
function legacyFixturesAllowed(options: RegisterPaperCandidatesOptions) {
  return options.allowLegacyFixtures === true || process.env.VITEST === "true";
}

export function registerPaperCandidates(
  repo = new PaperRepository(),
  now = Date.now(),
  rawSettings: unknown = {},
  options: RegisterPaperCandidatesOptions = {},
) {
  if (!legacyFixturesAllowed(options))
    throw new Error(
      "历史写死的 r2a-* 模拟候选账户已停用；请手动创建模拟账户。测试夹具须显式传入 allowLegacyFixtures。",
    );
  const config = paperSettingsSchema.parse(rawSettings);
  const chosen = selectShadowCandidates(frozen.ranking as ScoreboardRow[]);
  const candidates = [...frozen.candidates] as unknown as FrozenCandidate[];
  if (
    JSON.stringify(chosen.map((r) => r.id).sort()) !==
    JSON.stringify(candidates.map((c) => c.strategy.id).sort())
  )
    throw new Error("冻结成绩单与影子选取规则不一致");
  return repo.atomic(() => {
    const alerts = new AlertRepository(repo.db);
    for (const strategy of alerts.definitions()) {
      const qualification = alerts.records.read<{
        status: string;
        reasons: string[];
      }>(`strategy-qualification-${strategy.id}`);
      const manuallyShadowed =
        alerts.state<{ active: boolean }>(
          `shadow:${strategy.id}:${strategy.version}`,
        )?.active === true;
      if (
        (qualification?.status !== "live-candidate" && !manuallyShadowed) ||
        candidates.some(
          (c) =>
            c.strategy.id === strategy.id &&
            c.strategy.version === strategy.version,
        )
      )
        continue;
      const registered = alerts.state<FrozenCandidate["registration"]>(
        `shadow:${strategy.id}:${strategy.version}`,
      );
      const lifecycle = readLifecycleCandidateSource(strategy, alerts);
      candidates.push({
        strategy,
        ...(lifecycle
          ? {
              executionPolicy: lifecycle.executionPolicy,
              sourceContext: lifecycle.sourceContext,
            }
          : {}),
        row:
          lifecycle?.row ??
          unreviewedCandidateRow(
            strategy,
            qualification?.status === "live-candidate"
              ? "live-candidate"
              : "shadow-candidate",
            qualification?.reasons,
          ),
        registration: registered ?? inactivePaperRegistration,
        expectation: { windows: [], holdout: null },
      });
    }
    const groups = new Map<string, FrozenCandidate[]>();
    for (const candidate of candidates) {
      const strategy = strategyObjectSchema.parse(candidate.strategy);
      alerts.strategies.saveStrategy(strategy);
      const key = `shadow:${strategy.id}:${strategy.version}`;
      // Deployment gets its own prospective epoch; never import research timestamps.
      if (!alerts.state(key))
        alerts.saveState(key, {
          ...candidate.registration,
          active: false,
          startedAt: now,
        });
      const qualification = alerts.records.read<{ status: string }>(
        `strategy-qualification-${strategy.id}`,
      );
      if (!qualification)
        alerts.records.save(
          "strategy-qualification",
          `strategy-qualification-${strategy.id}`,
          {
            status:
              candidate.row.status === "live-candidate"
                ? "live-candidate"
                : "shadow-candidate",
            reasons: candidate.row.reasons,
            biasTags: candidate.row.biasTags,
          },
        );
      const group =
        config.grouping === "candidate"
          ? `${strategy.id}:v${strategy.version}`
          : `${strategy.market}:${strategy.sleeve}:v${strategy.version}`;
      const list = groups.get(group) ?? [];
      list.push({
        ...candidate,
        row: {
          ...candidate.row,
          status:
            qualification?.status === "live-candidate" ||
            candidate.row.status === "live-candidate"
              ? "live-candidate"
              : "shadow-candidate",
        },
        strategy,
      });
      groups.set(group, list);
    }
    // Changing grouping after registration would double-count the same candidate.
    const existing = repo.ids().map((id) => repo.account(id)!);
    let created = 0;
    for (const [group, grouped] of groups) {
      const rows = grouped.filter(
        (r) =>
          !existing.some((a) =>
            a.candidates.some(
              (c) =>
                c.strategy.id === r.strategy.id &&
                c.strategy.version === r.strategy.version,
            ),
          ),
      );
      if (!rows.length) continue;
      const first = rows[0]!.strategy;
      const policies = rows.flatMap((row) =>
        row.executionPolicy ? [row.executionPolicy] : [],
      );
      if (
        policies.length &&
        (rows.length !== 1 ||
          !isDeepStrictEqual(
            policies[0]!.sleeves.map((s) => s.id),
            [first.sleeve],
          ))
      )
        throw new Error(
          "L3独立策略分布只能登记独立纸面账户；合账需要新的同源评审",
        );
      const baseId = `paper:${group}`;
      createPaperAccount(
        repo,
        {
          id: repo.account(baseId) ? `${baseId}:from:${now}` : baseId,
          market: first.market,
          currency: first.market === "crypto" ? "USDT" : "CNY",
          sleeve: first.sleeve,
          initial:
            policies[0]?.initial ??
            (first.market === "crypto"
              ? config.cryptoInitial
              : config.equityInitial),
          candidates: rows,
        },
        now,
      );
      created++;
    }
    return {
      created,
      total: repo.ids().length,
      selected: candidates.map((c) => c.strategy.id),
      sourceSha256: frozen.sourceSha256,
    };
  });
}
