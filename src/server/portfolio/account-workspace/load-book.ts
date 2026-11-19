import { type Bar } from "~/lib/domain";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import { industryGroupsFor } from "~/lib/portfolio/account-workspace";
import { AccountWorkspaceRepository } from "../../db/account-workspace-repository";
import { settings } from "../../infra/settings";
import { readBars } from "../../market/bar-store/read-bars";
import { tradeContext } from "../trade-ledger-service";
import { binanceArchiveSource } from "../../market/bar-store/binance-archive-source";
import { readIndustryBlocks } from "../../market/industry-blocks";
import { createPositionLedgers } from "./position-ledgers";
import { readRealPositions } from "./real-positions";
import { readSimulatedPositions } from "./simulated-positions";

export type AccountBook = Awaited<ReturnType<typeof loadAccountBook>>;
/** No remote balance refresh, writes, notification or order calls on this path. */
export async function loadAccountBook(
  repo = new AccountWorkspaceRepository(),
  config = settings(),
  now = Date.now(),
  dependencies: {
    context?: Awaited<ReturnType<typeof tradeContext>>;
    bars?: Record<string, Bar[]>;
    localOnly?: boolean;
  } = {},
) {
  const facts = repo.snapshot(),
    context = dependencies.context ?? (await tradeContext());
  const today = chinaClock(now),
    bars: Record<string, Bar[]> = {};
  const symbols = [
    ...new Set([
      ...facts.fills.map((f) => f.symbol ?? f.code),
      ...facts.local.map((t) => t.symbol),
      ...facts.crypto.flatMap(
        (c) => c.snapshot?.positions.map((p) => p.symbol) ?? [],
      ),
    ]),
  ];
  for (const symbol of symbols) {
    const market = /USDT$/.test(symbol) ? "crypto" : "cn-equity";
    try {
      const result = dependencies.bars
        ? { bars: dependencies.bars[symbol] ?? [] }
        : market === "crypto"
          ? await binanceArchiveSource({
              symbol: `cx${symbol}`,
              period: "day",
              configuredRoot: config.binancePublicDataRoot,
              now,
            })
          : await readBars({
              instrument: { market, symbol },
              root: config.tdxRoot,
              period: "day",
              adjustment: "none",
              ...(dependencies.localOnly
                ? { live: false, source: "local" as const }
                : {}),
            });
      bars[symbol] = (result?.bars ?? []).filter(
        (b) =>
          b.date.slice(0, 10) <
            (market === "crypto"
              ? new Date(now).toISOString().slice(0, 10)
              : today.date) ||
          (market === "cn-equity" &&
            b.date.slice(0, 10) === today.date &&
            today.time >= "15:05"),
      );
    } catch {
      bars[symbol] = [];
    }
  }

  const ledgers = createPositionLedgers(facts);
  readRealPositions(ledgers, facts, context, repo, bars, today);
  readSimulatedPositions(ledgers, facts, repo);
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
  repo.assertVersion(facts.version);
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
