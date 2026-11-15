import { createHash, randomUUID } from "node:crypto";
import { AlertRepository } from "./alert-repository";
import { PaperRepository } from "./paper-repository";
import type { ValidationScoreboard } from "./validation-scoreboard";
import type { ShadowRegistration, ShadowSummary } from "../alerts/shadow";
import type { z } from "zod";
import { labActionSchema, labQuerySchema } from "~/lib/research/strategy-lab";

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
    version === 1
      ? (scoreboard?.rows.find((r) => r.id === id && r.level === "strategy") ??
        null)
      : null;
  const shadow =
    repo.state<ShadowRegistration>(`shadow:${id}:${version}`) ?? null;
  const forward =
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
  const eligible =
    !!strategy &&
    (row?.status === "live-candidate" ||
      forward?.assessment?.eligible === true);
  const reasons = eligible
    ? []
    : row?.reasons.length
      ? row.reasons
      : (forward?.assessment?.reasons ?? ["缺少通过相同门槛的研究或前推证据"]);
  const state = {
    strategy,
    row,
    shadow,
    forward,
    promotion,
    live,
    accounts,
    inputHash: scoreboard?.inputHash ?? null,
    resultHash: scoreboard?.resultHash ?? null,
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
      .map((r) => [r.id, r]),
  );
  const definitions = repo.definitions().filter((s) => s.market === q.market);
  const entries = definitions.map((s) => {
    const row = s.version === 1 ? (rows.get(s.id) ?? null) : null;
    const promotion = repo.state<Promotion>(`promotion:${s.id}:${s.version}`);
    const shadow = repo.state<ShadowRegistration>(
      `shadow:${s.id}:${s.version}`,
    );
    return {
      id: s.id,
      version: s.version,
      market: s.market,
      sleeve: s.sleeve,
      rule: row?.rule ?? s.entry.kind,
      status: promotion ? "promoted" : shadow?.active ? "shadow" : "research",
      row,
    };
  });
  for (const row of rows.values())
    if (!entries.some((e) => e.id === row.id && e.version === 1))
      entries.push({
        id: row.id,
        version: 1,
        market: row.market,
        sleeve: row.sleeve,
        rule: row.rule,
        status: "research",
        row,
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
      if (!detail.promotion || !detail.eligible)
        throw new Error("须先手动晋级，且当前研究或前推门槛通过");
      repo.saveState(`strategy:${key}`, { live: true, revision: randomUUID() });
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
    } else {
      if (detail.shadow)
        repo.saveState(`shadow:${key}`, { ...detail.shadow, active: false });
      repo.saveState(`strategy:${key}`, {
        live: false,
        revision: randomUUID(),
      });
    }
    const auditId = `strategy-governance:${randomUUID()}`;
    repo.records.save("strategy-governance", auditId, {
      ...input,
      at: now,
      inputHash: detail.inputHash,
    });
    return strategyLabDetail(input.id, input.version, repo);
  });
}
