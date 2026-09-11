import { createHash } from "node:crypto";
import { get, put, sqlite } from "./db";
import { settings } from "./settings";
import { securityNames, isAStock } from "./tdx";
import { storedSecurityLifecycle } from "./security-lifecycle";
import { storedSecurityTradingStatus } from "./security-trading-status";
import { exchangeNames } from "./exchange-security-names";
import type { Coverage } from "~/lib/domain";
export type SecurityProfile = {
  symbol: string;
  name: string;
  aliases: string[];
  market: string;
  type: "A股";
  currency: "CNY";
  nameSource: "tdx-tnf" | "tencent" | "hithink" | "exchange";
  tradingStatus: "unknown";
  updatedAt: number;
};
type Directory = {
  root: string;
  hash: string;
  currentSymbols?: string[];
  entries: Record<string, SecurityProfile>;
};
const refreshes = new Map<string, Promise<Directory>>();
let cached: { at: number; data: Directory } | undefined;
export async function securityDirectory(): Promise<Directory> {
  const root = settings().tdxRoot;
  if (cached && cached.data.root === root && Date.now() - cached.at < 60000)
    return cached.data;
  const inflight = refreshes.get(root);
  if (inflight) return inflight;
  const refresh = (async () => {
    const previous = get<Directory>("security-directory");
    const dictionaries = await Promise.all(
      ["sh", "sz", "bj"].map((market) => securityNames(root, market)),
    );
    const current = dictionaries
      .flatMap((dictionary) => [...dictionary])
      .filter(([symbol]) => isAStock(symbol))
      .sort(([a], [b]) => a.localeCompare(b));
    const coverage = get<Coverage>("coverage");
    const historical =
      coverage?.root === root
        ? [...new Set(coverage.securities.map((row) => row.symbol))].filter(
            (symbol) => exchangeNames.has(symbol),
          )
        : [];
    const hash = createHash("sha256")
      .update(root)
      .update(JSON.stringify(current))
      .update(
        JSON.stringify(
          historical.map((symbol) => [symbol, exchangeNames.get(symbol)]),
        ),
      )
      .digest("hex");
    if (
      previous?.root === root &&
      previous.hash === hash &&
      previous.currentSymbols
    ) {
      if (settings().tdxRoot === root)
        cached = { at: Date.now(), data: previous };
      return previous;
    }
    const entries = previous?.root === root ? { ...previous.entries } : {};
    for (const [symbol, name] of current) {
      const old = entries[symbol];
      entries[symbol] = {
        symbol,
        name,
        aliases: [
          ...new Set([
            ...(old?.aliases ?? []),
            ...(old && old.name !== name ? [old.name] : []),
          ]),
        ],
        market: symbol.slice(0, 2),
        type: "A股",
        currency: "CNY",
        nameSource: "tdx-tnf",
        tradingStatus: "unknown",
        updatedAt: old?.name === name ? old.updatedAt : Date.now(),
      };
    }
    const directory = {
      root,
      hash,
      entries,
      currentSymbols: current.map(([symbol]) => symbol),
    };
    for (const symbol of historical) {
      if (entries[symbol]) continue;
      entries[symbol] = {
        symbol,
        name: exchangeNames.get(symbol)!.name,
        aliases: [],
        market: symbol.slice(0, 2),
        type: "A股",
        currency: "CNY",
        nameSource: "exchange",
        tradingStatus: "unknown",
        updatedAt: Date.now(),
      };
    }
    if (settings().tdxRoot === root) {
      put("security-directory", "security-directory", directory);
      cached = { at: Date.now(), data: directory };
    }
    return directory;
  })();
  refreshes.set(root, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshes.get(root) === refresh) refreshes.delete(root);
  }
}
export function storedSecurityName(symbol: string) {
  const directory = get<Directory>("security-directory");
  return directory?.root === settings().tdxRoot
    ? directory.entries[symbol]?.name
    : undefined;
}
export function securityLabel(symbol: string) {
  const name = storedSecurityName(symbol);
  return name
    ? `${name} (${symbol.toUpperCase()})`
    : `${symbol.toUpperCase()}（名称待核验）`;
}
export async function securityNameMap() {
  return Object.fromEntries(
    Object.values((await securityDirectory()).entries).map((entry) => [
      entry.symbol,
      entry.name,
    ]),
  );
}
export async function securityProfile(symbol: string) {
  const directory = await securityDirectory();
  const entry = directory.entries[symbol];
  return {
    root: directory.root,
    profile: entry ?? null,
    lifecycle: storedSecurityLifecycle(symbol),
    tradingStatus: storedSecurityTradingStatus(symbol),
  };
}

export async function mergeVerifiedSecurityName(symbol: string, name: string) {
  const directory = await securityDirectory();
  if (settings().tdxRoot !== directory.root)
    throw new Error("核验期间数据目录发生变化，请重试");
  return sqlite()
    .transaction(() => {
      if (settings().tdxRoot !== directory.root)
        throw new Error("核验期间数据目录发生变化，请重试");
      const latest = get<Directory>("security-directory") ?? directory;
      if (latest.root !== directory.root)
        throw new Error("证券主档目录发生变化");
      const old = latest.entries[symbol];
      const entry: SecurityProfile = old
        ? {
            ...old,
            aliases: [
              ...new Set([
                ...old.aliases,
                ...(old.name !== name ? [name] : []),
              ]),
            ],
          }
        : {
            symbol,
            name,
            aliases: [],
            market: symbol.slice(0, 2),
            type: "A股",
            currency: "CNY",
            nameSource: "tencent",
            tradingStatus: "unknown",
            updatedAt: Date.now(),
          };
      const next = {
        ...latest,
        entries: { ...latest.entries, [symbol]: entry },
      };
      put("security-directory", "security-directory", next);
      cached = { at: Date.now(), data: next };
      return entry;
    })
    .immediate();
}
