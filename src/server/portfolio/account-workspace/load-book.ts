import { settingsSchema, type Bar, type Settings } from "~/lib/domain";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import {
  industryGroupsFor,
  type AccountMarket,
} from "~/lib/portfolio/account-workspace";
import {
  emptyAccountFacts,
  openAccountWorkspaceRead,
  type AccountWorkspaceRepository,
} from "../../db/account-workspace-repository";
import { readAccountEquitySource, readBookContext } from "./read-sources";
import type { tradeContext } from "../trade-ledger-service";
import { readPublicData } from "../../data-sources/binance/public-data-store";
import { readIndustryBlocks } from "../../market/industry-blocks";
import { createPositionLedgers } from "./position-ledgers";
import { readRealPositions } from "./real-positions";
import { readSimulatedPositions } from "./simulated-positions";
import { readDirectSimulation } from "./direct-simulation";

export type AccountBook = Awaited<ReturnType<typeof loadAccountBook>>;
/** No remote balance refresh, writes, notification or order calls on this path. */
export async function loadAccountBook(
  repo?: AccountWorkspaceRepository,
  config?: Settings,
  now = Date.now(),
  dependencies: {
    context?: Awaited<ReturnType<typeof tradeContext>>;
    bars?: Record<string, Bar[]>;
    /** All book sources are local. Kept for existing callers. */
    localOnly?: boolean;
  } = {},
) {
  const reader = repo ? undefined : openAccountWorkspaceRead();
  const repository = repo ?? reader?.repo;
  try {
    return await projectAccountBook(
      repository,
      config ?? settingsSchema.parse(repository?.record("settings") ?? {}),
      now,
      dependencies,
    );
  } finally {
    reader?.close();
  }
}

async function projectAccountBook(
  repo: AccountWorkspaceRepository | null | undefined,
  config: Settings,
  now: number,
  dependencies: NonNullable<Parameters<typeof loadAccountBook>[3]>,
) {
  const facts = repo?.snapshot(now) ?? emptyAccountFacts();
  const context =
    dependencies.context ?? (await readBookContext(config, now, repo));
  const today = chinaClock(now),
    utcDate = new Date(now).toISOString().slice(0, 10),
    bars: Record<string, Bar[]> = {};
  const symbols = new Map<string, AccountMarket>();
  for (const f of facts.fills) symbols.set(f.symbol ?? f.code, "cn-equity");
  for (const t of facts.local) symbols.set(t.symbol, "cn-equity");
  for (const { snapshot } of facts.crypto)
    for (const position of snapshot?.positions ?? [])
      symbols.set(position.symbol, "crypto");
  for (const { account, positions, trades } of facts.localSim) {
    for (const trade of trades) symbols.set(trade.symbol, account.market);
    for (const position of positions)
      symbols.set(position.symbol, account.market);
  }
  for (const account of facts.futuresSim)
    for (const position of account.positions)
      symbols.set(position.symbol, "futures");

  const cryptoBars = new Map<string, Bar[]>();
  for (const [symbol, market] of symbols) {
    try {
      let candidates: Bar[] = [];
      if (market === "crypto") {
        const pair = symbol.replace(/^cx/i, "");
        if (dependencies.bars) {
          candidates =
            dependencies.bars[symbol] ??
            dependencies.bars[pair] ??
            dependencies.bars[`cx${pair}`] ??
            [];
        } else {
          if (!cryptoBars.has(pair)) {
            const { rows } = await readPublicData(pair, "1d", {
              root: config.binancePublicDataRoot,
              now,
            });
            cryptoBars.set(
              pair,
              rows.map((row) => row.bar),
            );
          }
          candidates = cryptoBars.get(pair)!;
        }
      } else if (dependencies.bars) {
        candidates = dependencies.bars[symbol] ?? [];
      } else if (market === "cn-equity") {
        candidates = await readAccountEquitySource(
          config.tdxRoot,
          symbol,
          repo,
        );
      }
      const dateLimit = market === "cn-equity" ? today.date : utcDate;
      bars[symbol] = candidates
        .filter((bar) => {
          const date = bar.date.slice(0, 10);
          if (!Number.isFinite(bar.close) || bar.close <= 0) return false;
          if (bar.date.length > 10 && !(Date.parse(bar.date) <= now))
            return false;
          return (
            date < dateLimit ||
            (market === "cn-equity" &&
              date === dateLimit &&
              today.time >= "15:05")
          );
        })
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch {
      bars[symbol] = [];
    }
  }

  const ledgers = createPositionLedgers(facts);
  if (repo) {
    readRealPositions(ledgers, facts, context, repo, bars, today);
    readSimulatedPositions(ledgers, facts, repo);
  }
  readDirectSimulation(ledgers, facts, bars);
  const { positions, trades } = ledgers;
  const industryBySymbol = new Map<string, string[]>();
  let industrySource: {
    hash: string;
    basis: "current-labelled";
    grouping: "all-known-groups";
  } | null = null;
  if (config.industryBlocksRoot) {
    try {
      const blocks = await readIndustryBlocks(config.industryBlocksRoot);
      industrySource = {
        hash: blocks.hash,
        basis: "current-labelled",
        grouping: "all-known-groups",
      };
      for (const file of blocks.files)
        for (const symbol of file.members)
          industryBySymbol.set(symbol, [
            ...new Set([...(industryBySymbol.get(symbol) ?? []), file.name]),
          ]);
    } catch {
      /* Missing classification is surfaced on each position and cap check. */
    }
  }
  for (const p of positions.filter((p) => p.market === "cn-equity")) {
    const industries = industryGroupsFor({
      industryGroups: industryBySymbol.get(p.symbol) ?? [],
    });
    p.industryGroups = industries;
    p.industry = industries.join("、") || "未知";
    p.reasons.push(
      industries.length
        ? "行业组为当前Blocks成分，各已知组分别校验，不代表历史归属"
        : "行业组缺失，无法确认行业组敞口",
    );
  }
  for (const p of positions.filter((p) => p.market === "crypto"))
    p.industryGroups = industryGroupsFor(p);
  repo?.assertVersion(facts.version);
  return {
    facts,
    positions,
    trades,
    bars,
    calendar: context.calendar,
    context,
    config,
    industryBySymbol,
    industrySource,
  };
}
