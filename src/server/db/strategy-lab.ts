import { createHash, randomUUID } from "node:crypto";
import { AlertRepository } from "./alert-repository";
import { PaperRepository } from "./paper-repository";
import type { ValidationScoreboard } from "./validation-scoreboard";
import type { ShadowRegistration, ShadowSummary } from "../alerts/shadow";
import { z } from "zod";
import { evaluatePerformance } from "quant-performance";
import { dailyEquity } from "~/lib/backtest/daily-equity";
import { readJob } from "./jobs";
import { labActionSchema, labQuerySchema } from "~/lib/research/strategy-lab";
import { ForwardReferenceRepository } from "./forward-reference-repository";
import { forwardExecutionBuildHash } from "../research/forward-identity";
import { AccountWorkspaceRepository } from "./account-workspace-repository";
import { freezeMatchingAccountExpectation } from "../portfolio/account-expectation-service";

type Promotion = { at: number; inputHash: string | null; reasons: string[] };
function strategyState(
  id: string,
  version: number,
  repo = new AlertRepository(),
) {
  const strategy = repo.strategies.strategy(id, version);
  const scoreboard = strategy
    ? repo.records.read<ValidationScoreboard>(
        `validation-scoreboard-${strategy.market}`,
      )
    : ((["cn-equity", "crypto"] as const)
        .map((market) =>
          repo.records.read<ValidationScoreboard>(
            `validation-scoreboard-${market}`,
          ),
        )
        .find((board) =>
          board?.rows.some((r) => r.id === id && r.level === "strategy"),
        ) ?? null);
  // Current scoreboard artifacts bind research candidates to their original v1.
  // A new version never inherits a different definition's qualification.
  const row =
    scoreboard?.rows.find(
      (r) =>
        r.id === id &&
        r.level === "strategy" &&
        (r.strategyVersion ?? 1) === version,
    ) ?? null;
  const shadow =
    repo.state<ShadowRegistration>(`shadow:${id}:${version}`) ?? null;
  const legacyForward =
    repo.state<ShadowSummary>(`shadow-summary:${id}:${version}`) ?? null;
  const promotion = repo.state<Promotion>(`promotion:${id}:${version}`) ?? null;
  const live =
    repo.state<{ live: boolean }>(`strategy:${id}:${version}`)?.live ?? false;
  const paper = new PaperRepository(repo.db);
  const accounts = paper.ids().flatMap((key) => {
    const account = paper.account(key)!;
    const candidate = account.candidates.find(
      (c) => c.strategy.id === id && c.strategy.version === version,
    );
    return candidate
      ? [
          {
            id: account.id,
            summary: account.summary,
            lastBar: account.lastBar,
            expectation: candidate.expectation,
            singleStrategy: account.candidates.length === 1,
          },
        ]
      : [];
  });
  let currentBuild: string | null = null;
  try {
    currentBuild = forwardExecutionBuildHash();
  } catch {
    /* Missing identity leaves qualification unavailable. */
  }
  const forwardAssessment =
    accounts.find((account) => {
      const full = paper.account(account.id)!;
      const assessment = account.summary?.assessment;
      const reference = strategy
        ? new ForwardReferenceRepository(repo.db).paper(
            account.id,
            strategy,
            full.startedAt,
          )
        : null;
      return (
        assessment?.method === "forward-conformance-1" &&
        reference &&
        assessment.referenceHash === reference.contentHash &&
        reference.identity.buildHash === currentBuild
      );
    })?.summary?.assessment ?? null;
  const eligible = !!strategy && forwardAssessment?.eligible === true;
  const forward = {
    signals: legacyForward?.signals ?? accounts[0]?.summary?.signals ?? 0,
    days: legacyForward?.days ?? accounts[0]?.summary?.days ?? 0,
    paused: legacyForward?.paused ?? false,
    assessment: forwardAssessment
      ? { ...forwardAssessment, at: forwardAssessment.asOf ?? 0, eligible }
      : null,
  };
  const reasons = eligible
    ? []
    : [
        ...new Set([
          ...(row?.reasons ?? []),
          ...(forwardAssessment?.reasons ?? [
            "missing-same-version-forward-conformance",
          ]),
        ]),
      ];
  const state = {
    strategy,
    row,
    shadow,
    forward,
    forwardAssessment,
    unvalidatedLive:
      live &&
      repo.state<{ unvalidatedOverride?: boolean }>(`strategy:${id}:${version}`)
        ?.unvalidatedOverride === true,
    promotion,
    live,
    accounts,
    inputHash:
      row?.evidenceScope === "candidate"
        ? (row.evidence?.inputHash ?? null)
        : (row?.evidence?.inputHash ?? scoreboard?.inputHash ?? null),
    resultHash:
      row?.evidenceScope === "candidate"
        ? (row.evidence?.resultHash ?? null)
        : (row?.evidence?.resultHash ?? scoreboard?.resultHash ?? null),
    eligible,
    reasons,
  };
  return {
    ...state,
    revision: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
  };
}
const identity = z.object({
  id: z.string(),
  version: z.number().int().positive(),
});
const runWindow = z.object({
  start: z.string(),
  end: z.string(),
  initial: z.number().positive(),
});
const centerFrozen = z.object({
  input: runWindow.extend({
    strategyId: z.string(),
    symbol: z.string().optional(),
    symbols: z.array(z.string()).optional(),
  }),
  strategyObject: identity.optional(),
  sourceHash: z.string().optional(),
  calendarHash: z.string().optional(),
  benchmarkHash: z.string().optional(),
  sources: z.unknown(),
  options: z.unknown(),
  engineVersion: z.string().optional(),
  version: z.string(),
  strategyBuildHash: z.string(),
  native: z.unknown(),
  actions: z.unknown(),
  dividends: z.unknown(),
  stocks: z
    .array(z.object({ symbol: z.string(), actions: z.unknown() }))
    .optional(),
});
const labFrozen = z.object({
  request: runWindow.extend({
    market: z.string(),
    strategies: z.tuple([identity.extend({ period: z.string() })]),
    instruments: z
      .array(
        z.object({
          symbol: z.string(),
          actions: z.unknown(),
          execution: z.unknown(),
        }),
      )
      .min(1),
    costs: z.unknown(),
    calendar: z.array(z.string()),
    sleeves: z.unknown(),
  }),
  sources: z.unknown(),
  costScenario: z.string().optional(),
  marketPolicy: z.unknown(),
  strategyBuildHash: z.string(),
  executionBuildHash: z.string().optional(),
});
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function runSummary(
  id: string,
  kind: "strategy-center" | "lab-backtest",
  result: unknown,
) {
  const archive = z
    .object({
      inputHash: z.string(),
      frozen: z.record(z.string(), z.unknown()),
      result: z.object({
        curve: z
          .array(z.object({ date: z.string(), equity: z.number().finite() }))
          .min(1),
      }),
    })
    .parse(result);
  if (digest(archive.frozen) !== archive.inputHash)
    throw new Error("任务冻结输入哈希不匹配：" + id);
  const lab = kind === "lab-backtest" ? labFrozen.parse(archive.frozen) : null;
  const center =
    kind === "strategy-center" ? centerFrozen.parse(archive.frozen) : null;
  const window = lab?.request ?? center!.input;
  const symbols =
    lab?.request.instruments.map((i) => i.symbol) ??
    center?.input.symbols ??
    (center?.input.symbol ? [center.input.symbol] : []);
  if (!symbols.length) throw new Error("任务缺少冻结证券池：" + id);
  const strategy = lab?.request.strategies[0] ?? center?.strategyObject;
  const annualizationDays = lab?.request.market === "crypto" ? 365 : 252;
  const costScenario = lab?.costScenario ?? null;
  const basis = {
    任务类型: kind,
    市场: lab?.request.market ?? "cn-equity",
    周期: lab?.request.strategies[0].period ?? "day",
    起止日期: [window.start, window.end],
    初始资金: window.initial,
    证券池: [...symbols].sort(),
    费用情景: costScenario,
    费用与成交假设: lab
      ? [
          lab.request.costs,
          lab.marketPolicy,
          lab.request.instruments.map((i) => [i.symbol, i.execution]),
        ]
      : [center!.version, center!.options, center!.native],
    行情来源与公司行动: lab
      ? [lab.sources, lab.request.instruments.map((i) => [i.symbol, i.actions])]
      : [
          center!.sourceHash,
          center!.sources,
          center!.benchmarkHash,
          center!.actions,
          center!.dividends,
          center!.stocks,
        ],
    交易日历:
      lab?.request.calendar ?? center?.calendarHash ?? center?.benchmarkHash,
    分仓风控: lab?.request.sleeves ?? center?.options,
    实现版本: [
      lab?.strategyBuildHash ?? center?.strategyBuildHash,
      lab?.executionBuildHash ?? center?.engineVersion,
    ],
  };
  const warnings: string[] = [];
  if (!strategy) warnings.push("策略版本号未冻结");
  if (!costScenario) warnings.push("费用情景名称未冻结");
  if (
    lab &&
    (!lab.sources ||
      !lab.marketPolicy ||
      !lab.executionBuildHash ||
      !lab.request.costs)
  )
    warnings.push("缺少行情来源、成交假设或执行版本");
  if (center && !(center.sourceHash || center.sources))
    warnings.push("缺少行情来源");
  return {
    id,
    kind,
    strategyId: strategy?.id ?? center!.input.strategyId,
    strategyVersion: strategy?.version ?? null,
    start: window.start,
    end: window.end,
    initial: window.initial,
    symbolCount: symbols.length,
    costScenario,
    metrics: evaluatePerformance(
      window.initial,
      dailyEquity(archive.result.curve),
      undefined,
      annualizationDays,
    ),
    basisWarnings: warnings,
    basis: Object.entries(basis).map(([label, value]) => ({
      label,
      hash: digest(value ?? null),
    })),
    inputHash: archive.inputHash,
  };
}
export function strategyLabCompareRuns(ids: readonly string[], load = readJob) {
  const rows = ids.map((id) => {
    const job = load(id);
    const kind = (job?.input as { type?: unknown } | undefined)?.type;
    if (
      job?.status !== "completed" ||
      (kind !== "strategy-center" && kind !== "lab-backtest")
    )
      throw new Error("仅支持已完成的策略中心或实验室回测任务：" + id);
    return runSummary(id, kind, job.result);
  });
  const different =
    rows[0]?.basis
      .filter((field, i) =>
        rows.some((row) => row.basis[i]?.hash !== field.hash),
      )
      .map((field) => field.label + "不同") ?? [];
  return rows.map(({ basis: _basis, inputHash: _inputHash, ...row }) => ({
    ...row,
    basisWarnings: [...row.basisWarnings, ...different],
  }));
}

type LifecycleRun = {
  id: string;
  inputHash: string;
  bars: number;
  strategyId: string;
  strategyVersion: number;
};
type RunIndex = {
  revision: number;
  byVersion: Map<string, LifecycleRun[]>;
  peers: Map<string, { id: string } | null>;
};
const jobIndexes = new WeakMap<AlertRepository["db"], RunIndex>();
function lifecycleRunIndex(repo: AlertRepository) {
  const revision =
    (
      repo.db
        .prepare("SELECT revision FROM record_kind_revisions WHERE kind='job'")
        .get() as { revision: number } | undefined
    )?.revision ?? 0;
  const cached = jobIndexes.get(repo.db);
  if (cached?.revision === revision && !repo.db.inTransaction) return cached;
  const index: RunIndex = { revision, byVersion: new Map(), peers: new Map() };
  // One compact projection per job revision for every strategy on the scan page.
  const rows = repo.db
    .prepare(
      `SELECT id,json_extract(payload,'$.result.inputHash') inputHash,
    json_array_length(payload,'$.result.result.curve') bars,
    coalesce(json_extract(payload,'$.result.frozen.request.strategies[0].id'),json_extract(payload,'$.result.frozen.strategyObject.id')) strategyId,
    coalesce(json_extract(payload,'$.result.frozen.request.strategies[0].version'),json_extract(payload,'$.result.frozen.strategyObject.version')) strategyVersion
    FROM records WHERE kind='job' AND json_extract(payload,'$.status')='completed'
    AND json_extract(payload,'$.input.type') IN ('lab-backtest','strategy-center')
    AND json_type(payload,'$.result.result.fills')='array'
    AND coalesce(json_type(payload,'$.result.inputDiagnostics'),json_type(payload,'$.result.portfolio.rejections'))='array'
    AND strategyId IS NOT NULL AND strategyVersion>0 AND bars>0 AND length(inputHash)=64
    ORDER BY updated_at DESC,id`,
    )
    .all() as LifecycleRun[];
  for (const run of rows) {
    if (!/^[a-f0-9]{64}$/.test(run.inputHash)) continue;
    const key = run.strategyId + ":" + run.strategyVersion;
    const group = index.byVersion.get(key) ?? [];
    group.push(run);
    index.byVersion.set(key, group);
  }
  // Never publish data read within a caller's uncommitted transaction.
  if (!repo.db.inTransaction) jobIndexes.set(repo.db, index);
  return index;
}

function comparablePortfolioRun(repo: AlertRepository, jobId: string) {
  // Remove strategy definitions and their generated decisions only. Keep all market,
  // source, portfolio and execution assumptions in the peer comparison.
  const basis = `CASE json_extract(payload,'$.input.type')
    WHEN 'lab-backtest' THEN json_remove(json_extract(payload,'$.result.frozen'),'$.request.strategies')
    WHEN 'strategy-center' THEN json_remove(json_extract(payload,'$.result.frozen'),'$.input.strategyId','$.input.strategy','$.strategyObject','$.decisions','$.schedule')
    END`;
  return repo.db
    .prepare(
      `WITH target AS (
    SELECT id,json_extract(payload,'$.input.type') kind,
      json_extract(payload,'$.result.frozen.request.strategies[0].period') period,
      ${basis} basis FROM records WHERE id=?
  ) SELECT id FROM records WHERE kind='job' AND id<>(SELECT id FROM target)
    AND json_extract(payload,'$.input.type')=(SELECT kind FROM target)
    AND json_extract(payload,'$.status')='completed'
    AND json_array_length(payload,'$.result.result.curve')>0 AND json_type(payload,'$.result.result.fills')='array'
    AND coalesce(json_type(payload,'$.result.inputDiagnostics'),json_type(payload,'$.result.portfolio.rejections'))='array'
    AND json_extract(payload,'$.result.frozen.request.strategies[0].period') IS (SELECT period FROM target)
    AND ${basis}=(SELECT basis FROM target)
    ORDER BY updated_at DESC,id LIMIT 1`,
    )
    .get(jobId) as { id: string } | undefined;
}
export function strategyLabDetail(
  id: string,
  version: number,
  repo = new AlertRepository(),
) {
  const state = strategyState(id, version, repo);
  const index = lifecycleRunIndex(repo);
  const runs = index.byVersion.get(id + ":" + version) ?? [];
  const hash = runs[0]?.inputHash ?? state.row?.evidence?.inputHash ?? null;
  let backtest = runs[0];
  let comparison: { id: string } | undefined;
  for (const run of runs) {
    if (!index.peers.has(run.id))
      index.peers.set(run.id, comparablePortfolioRun(repo, run.id) ?? null);
    comparison = index.peers.get(run.id) ?? undefined;
    if (comparison) {
      backtest = run;
      break;
    }
  }
  const paper = state.accounts.map((a) => ({
    id: a.id,
    signals: a.singleStrategy
      ? (a.summary?.assessment?.observedSignals ?? a.summary?.signals ?? null)
      : null,
    days: a.singleStrategy
      ? (a.summary?.assessment?.conformance?.days ?? a.summary?.days ?? null)
      : null,
  }));
  const observed = paper.some(
    (p) => (p.signals ?? 0) >= 30 || (p.days ?? 0) >= 60,
  );
  const gates = [
    {
      key: "definition",
      label: "定义冻结",
      passed: !!state.strategy && !!hash,
      started: !!state.strategy,
      summary: !state.strategy
        ? "策略版本未登记"
        : hash
          ? "策略版本和输入已冻结"
          : "策略已登记，缺少冻结输入哈希",
      evidence: hash ? [hash] : [],
    },
    {
      key: "backtest",
      label: "回测证据",
      passed: !!backtest,
      started: false,
      summary: backtest
        ? "已完成同版本组合回测"
        : "缺少该版本已完成的权益、成交和诊断记录",
      evidence: backtest ? [backtest.id, backtest.bars + " 根权益记录"] : [],
    },
    {
      key: "comparison",
      label: "同口径对比",
      passed: !!comparison,
      started: false,
      summary: comparison
        ? "存在同市场、同数据和成交口径的已完成任务"
        : "尚未找到同口径的已完成对照任务",
      evidence: comparison ? [backtest!.id, comparison.id] : [],
    },
    {
      key: "paper",
      label: "纸面前推",
      passed: observed,
      started: paper.length > 0,
      summary: observed
        ? "同版本账户已达到观察样本数"
        : paper.length
          ? "纸面账户观察样本不足"
          : "未登记同版本纸面账户",
      evidence: paper.map(
        (p) =>
          p.id +
          " · " +
          (p.signals ?? "未知") +
          "/30 信号 · " +
          (p.days ?? "未知") +
          "/60 日",
      ),
    },
    {
      key: "shadow",
      label: "影子前推",
      passed: state.shadow?.active === true,
      started: !!state.shadow,
      summary: state.shadow?.active
        ? "已登记并启用影子观察"
        : state.shadow
          ? "影子观察已暂停"
          : "尚未登记影子观察",
      evidence: state.shadow ? [String(state.shadow.startedAt)] : [],
    },
    {
      key: "promotion",
      label: "晋级观察",
      passed: state.eligible && !!state.promotion,
      started: state.eligible,
      summary: !state.eligible
        ? "同版本前推一致性门槛未通过"
        : state.promotion
          ? "已人工晋级"
          : "可晋级，等待人工确认",
      evidence: state.promotion ? [String(state.promotion.at)] : [],
    },
  ];
  const first = gates.findIndex((g) => !g.passed);
  const lifecycleGates = gates.map(({ passed, started, ...gate }, index) => ({
    ...gate,
    status: passed
      ? ("passed" as const)
      : index === first
        ? started
          ? ("current" as const)
          : ("blocked" as const)
        : ("pending" as const),
  }));
  const blocker = lifecycleGates[first];
  return {
    ...state,
    lifecycleGates,
    primaryBlocker: blocker
      ? { key: blocker.key, stage: first + 1, reason: blocker.summary }
      : null,
    liveSwitch: {
      enabled: state.live,
      manual: true as const,
      summary: state.live
        ? "已手动开启此版本的 live 提醒"
        : "此版本的 live 提醒未开启",
    },
  };
}
export function strategyLabPage(
  raw: z.input<typeof labQuerySchema>,
  repo = new AlertRepository(),
) {
  const q = labQuerySchema.parse(raw);
  const saved = repo.records.read<ValidationScoreboard>(
    `validation-scoreboard-${q.market}`,
  );
  const rows = new Map(
    (saved?.rows ?? [])
      .filter((r) => r.level === "strategy")
      .map((r) => [`${r.id}:${r.strategyVersion ?? 1}`, r]),
  );
  const definitions = repo.definitions().filter((s) => s.market === q.market);
  const entries = definitions.map((s) => {
    const row = rows.get(`${s.id}:${s.version}`) ?? null;
    const promotion = repo.state<Promotion>(`promotion:${s.id}:${s.version}`);
    const shadow = repo.state<ShadowRegistration>(
      `shadow:${s.id}:${s.version}`,
    );
    const detail = strategyState(s.id, s.version, repo);
    return {
      id: s.id,
      version: s.version,
      market: s.market,
      sleeve: s.sleeve,
      rule: row?.rule ?? s.entry.kind,
      status:
        detail.eligible && promotion
          ? "promoted"
          : shadow?.active
            ? "shadow"
            : "research",
      row,
      forwardVerdict: detail.forwardAssessment?.verdict ?? "insufficient",
      unvalidatedLive: detail.unvalidatedLive,
    };
  });
  for (const row of rows.values())
    if (
      !entries.some(
        (e) => e.id === row.id && e.version === (row.strategyVersion ?? 1),
      )
    )
      entries.push({
        id: row.id,
        version: row.strategyVersion ?? 1,
        market: row.market,
        sleeve: row.sleeve,
        rule: row.rule,
        status: "research",
        row,
        forwardVerdict: "insufficient",
        unvalidatedLive: false,
      });
  const selected = entries
    .filter((e) =>
      `${e.id} ${e.rule} ${e.sleeve}`
        .toLowerCase()
        .includes(q.query.toLowerCase()),
    )
    .sort((a, b) => a.id.localeCompare(b.id) || b.version - a.version);
  return {
    total: selected.length,
    items: selected.slice(q.page * 20, (q.page + 1) * 20),
  };
}
/** User actions affect observation state only. They do not send, subscribe,
 * place orders, or alter global alert mode. Keep append-only governance audit. */
export function actOnLabStrategy(
  raw: z.input<typeof labActionSchema>,
  repo = new AlertRepository(),
  now = Date.now(),
) {
  const input = labActionSchema.parse(raw);
  return repo.atomic(() => {
    const detail = strategyLabDetail(input.id, input.version, repo);
    if (!detail.strategy) throw new Error("策略对象未登记，请先完成研究登记");
    if (detail.revision !== input.revision)
      throw new Error("门槛或前推样本已更新，请重新核对并确认");
    const key = `${input.id}:${input.version}`;
    if (input.action === "promote") {
      if (!detail.eligible)
        throw new Error(`晋级门槛未通过：${detail.reasons.join("；")}`);
      repo.saveState(`promotion:${key}`, {
        at: now,
        inputHash: detail.inputHash,
        reasons: detail.reasons,
      });
    } else if (input.action === "live") {
      if ((!detail.promotion || !detail.eligible) && !input.riskAccepted)
        throw new Error(
          "须先手动晋级，且回测及前推一致性通过；研究策略仅可在明确接受未验证风险后手动开启提醒",
        );
      repo.saveState(`strategy:${key}`, {
        live: true,
        revision: randomUUID(),
        unvalidatedOverride: !detail.eligible,
        warning: !detail.eligible ? detail.reasons : [],
      });
      if (detail.shadow)
        repo.saveState(`shadow:${key}`, { ...detail.shadow, active: false });
    } else if (input.action === "shadow") {
      const saved = detail.shadow;
      // Previously recorded observations retain their epoch. A new strategy
      // begins now, never at a backdated research timestamp.
      const registration: ShadowRegistration = saved
        ? { ...saved, active: true }
        : {
            startedAt: now,
            active: true,
            status: "shadow-candidate",
            trialSharpes: [],
            neighbors: detail.row?.trainingNeighbors ?? [],
            sizing: "legacy",
            completeMarketCycles: 0,
            lowZoneCorroborated: false,
          };
      if (!saved) {
        const board = repo.records.read<ValidationScoreboard>(
          `validation-scoreboard-${detail.strategy.market}`,
        );
        registration.trialSharpes = board?.trialSharpes ?? [];
      }
      repo.saveState(`shadow:${key}`, registration);
      repo.saveState(`strategy:${key}`, {
        live: false,
        revision: randomUUID(),
      });
    } else if (input.action === "pause-live") {
      repo.saveState(`strategy:${key}`, {
        live: false,
        revision: randomUUID(),
      });
    } else {
      if (detail.shadow)
        repo.saveState(`shadow:${key}`, { ...detail.shadow, active: false });
      repo.saveState(`strategy:${key}`, {
        live: false,
        revision: randomUUID(),
      });
    }
    const auditId = `strategy-governance:${randomUUID()}`;
    if (input.action === "shadow" || input.action === "promote") {
      const reference = detail.forwardAssessment?.referenceHash
        ? new ForwardReferenceRepository(repo.db).read(
            detail.forwardAssessment.referenceHash,
          )
        : null;
      const selected = reference
        ? {
            inputHash: reference.identity.inputHash,
            resultHash: reference.resultHash,
            buildHash: reference.identity.buildHash,
          }
        : detail.row &&
            detail.inputHash &&
            detail.resultHash &&
            /^[a-f0-9]{64}$/.test(detail.inputHash) &&
            /^[a-f0-9]{64}$/.test(detail.resultHash)
          ? { inputHash: detail.inputHash, resultHash: detail.resultHash }
          : undefined;
      freezeMatchingAccountExpectation(
        input.id,
        input.version,
        new AccountWorkspaceRepository(repo.db),
        selected,
      );
    }
    repo.records.save("strategy-governance", auditId, {
      ...input,
      at: now,
      inputHash: detail.inputHash,
    });
    return strategyLabDetail(input.id, input.version, repo);
  });
}
