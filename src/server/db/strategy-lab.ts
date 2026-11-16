import { createHash, randomUUID } from "node:crypto";
import { AlertRepository } from "./alert-repository";
import { PaperRepository } from "./paper-repository";
import type { ValidationScoreboard } from "./validation-scoreboard";
import type { ShadowRegistration, ShadowSummary } from "../alerts/shadow";
import type { z } from "zod";
import { labActionSchema, labQuerySchema } from "~/lib/research/strategy-lab";
import { ForwardReferenceRepository } from "./forward-reference-repository";
import { forwardExecutionBuildHash } from "../research/forward-identity";
import { AccountWorkspaceRepository } from "./account-workspace-repository";
import { freezeMatchingAccountExpectation } from "../portfolio/account-expectation-service";

type Promotion = { at: number; inputHash: string | null; reasons: string[] };
export function strategyLabDetail(
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
    const detail = strategyLabDetail(s.id, s.version, repo);
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
