import { randomUUID } from "node:crypto";
import { strategyObjectSchema } from "trading-strategies";
import frozen from "../data/paper-candidates.json";
import { PaperRepository } from "../db/paper-repository";
import { AlertRepository } from "../db/alert-repository";
import { selectShadowCandidates } from "../research/shadow-selection";
import type { ScoreboardRow } from "../research/validation-model";
import {
  paperSettingsSchema,
  type FrozenCandidate,
  type PaperAccount,
} from "./model";

export function registerPaperCandidates(
  repo = new PaperRepository(),
  now = Date.now(),
  rawSettings: unknown = {},
) {
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
      if (
        qualification?.status !== "live-candidate" ||
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
      candidates.push({
        strategy,
        row: {
          id: strategy.id,
          level: "strategy",
          market: strategy.market,
          sleeve: strategy.sleeve,
          rule: strategy.entry.kind,
          status: "live-candidate",
          reasons: qualification.reasons,
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
        },
        registration: registered ?? {
          status: "shadow-candidate",
          active: false,
          trialSharpes: [],
          neighbors: [],
          sizing: "legacy",
          completeMarketCycles: 0,
          lowZoneCorroborated: false,
        },
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
        alerts.saveState(key, { ...candidate.registration, startedAt: now });
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
      const baseId = `paper:${group}`;
      const account: PaperAccount = {
        id: repo.account(baseId) ? `${baseId}:from:${now}` : baseId,
        market: first.market,
        currency: first.market === "crypto" ? "USDT" : "CNY",
        sleeve: first.sleeve,
        initial:
          first.market === "crypto"
            ? config.cryptoInitial
            : config.equityInitial,
        startedAt: now,
        candidates: rows,
        mirror: { venue: "off" },
        mirrorRevision: randomUUID(),
        revision: 0,
        lastBar: null,
        lastRun: null,
        error: null,
        summary: null,
      };
      if (repo.create(account)) created++;
    }
    return {
      created,
      total: repo.ids().length,
      selected: candidates.map((c) => c.strategy.id),
      sourceSha256: frozen.sourceSha256,
    };
  });
}
