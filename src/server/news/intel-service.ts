import { z } from "zod";
import {
  normalizeWorkspaceNewsText,
  queryWorkspaceNews,
  relatedNewsEvents,
} from "../db/news-workspace-query";
import { settings } from "../infra/settings";
import { storedSecurityName } from "../market/securities";
import { loadAccountBook } from "../portfolio/account-workspace-service";
import { AlertRepository } from "../db/alert-repository";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";

const workspaceNewsSymbol = z
  .string()
  .trim()
  .max(20)
  .transform((symbol) =>
    symbol
      .normalize("NFKC")
      .toLowerCase()
      .replace(/^(\d{6})\.(sh|sz|bj)$/, "$2$1"),
  )
  .pipe(z.string().regex(/^(sh|sz|bj)\d{6}$/));
const workspaceNewsSecurity = z.object({
  symbol: workspaceNewsSymbol,
  name: z.string().trim().max(100).nullish(),
});
export const workspaceNewsInputSchema = z
  .object({
    holdings: workspaceNewsSecurity.array().max(500).default([]),
    watchlist: workspaceNewsSecurity.array().max(500).default([]),
    candidates: workspaceNewsSecurity.array().max(500).default([]),
    lookbackDays: z.number().int().min(1).max(30).default(7),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export type WorkspaceNewsInput = z.input<typeof workspaceNewsInputSchema>;
const workspaceSourceLabels = {
  holding: "持仓",
  watchlist: "自选",
  candidate: "候选",
} as const;
export type WorkspaceNewsSource = keyof typeof workspaceSourceLabels;
export type WorkspaceNewsMatch = {
  symbol: string;
  name: string | null;
  sources: WorkspaceNewsSource[];
  sourceLabels: (typeof workspaceSourceLabels)[WorkspaceNewsSource][];
};
function workspaceMatcher(input: z.output<typeof workspaceNewsInputSchema>) {
  const targets = new Map<string, WorkspaceNewsMatch>();
  const names = new Map<string, Set<string>>();
  const codes = new Map<string, Set<string>>();
  const groups = [
    ["holding", input.holdings],
    ["watchlist", input.watchlist],
    ["candidate", input.candidates],
  ] as const;
  const associate = (
    index: Map<string, Set<string>>,
    key: string,
    symbol: string,
  ) => {
    const symbols = index.get(key) ?? new Set();
    symbols.add(symbol);
    index.set(key, symbols);
  };
  for (const [source, securities] of groups) {
    for (const { symbol, name } of securities) {
      const target = targets.get(symbol) ?? {
        symbol,
        name: null,
        sources: [],
        sourceLabels: [],
      };
      if (!target.sources.includes(source)) {
        target.sources.push(source);
        target.sourceLabels.push(workspaceSourceLabels[source]);
      }
      if (name && name.length >= 2) {
        target.name ??= name;
        associate(names, normalizeWorkspaceNewsText(name), symbol);
      }
      associate(codes, symbol.slice(2), symbol);
      targets.set(symbol, target);
    }
  }
  // Bare numeric codes and equal names can be ambiguous. A market-qualified
  // token still identifies the security even when its bare code is shared.
  const unique = (symbols?: Set<string>) =>
    symbols?.size === 1 ? symbols.values().next().value : undefined;
  const token =
    /(?<![A-Z0-9_.])(?:(SH|SZ|BJ)\.?(\d{6})|(\d{6})(?:\.(SH|SZ|BJ))?)(?![A-Z0-9_.])/g;
  const numericUnit = /^\s*(?:万|亿|元|股(?!票)|手|份|%|‰)/u;
  const byName = [...names].flatMap(([name, symbols]) => {
    const symbol = unique(symbols);
    return symbol ? [{ name, symbol }] : [];
  });
  function match(title: string, content: string) {
    const matched = new Set<string>();
    for (const field of [title, content]) {
      const text = normalizeWorkspaceNewsText(field);
      for (const m of text.matchAll(token)) {
        const exchange = m[1] ?? m[4];
        const code = m[2] ?? m[3]!;
        if (!exchange && numericUnit.test(text.slice(m.index + m[0].length)))
          continue;
        const symbol = exchange
          ? exchange.toLowerCase() + code
          : unique(codes.get(code));
        if (symbol && targets.has(symbol)) matched.add(symbol);
      }
      for (const { name, symbol } of byName) {
        if (text.includes(name)) matched.add(symbol);
      }
    }
    return [...matched].map((symbol) => targets.get(symbol)!);
  }
  const terms = [
    ...new Set([...codes.keys(), ...byName.map(({ name }) => name)]),
  ];
  return { terms, match };
}

/** Client supplies its own scope. This query never loads the account book or
 * participates in todayWorkspace's polling path. */
export function workspaceNews(
  raw: WorkspaceNewsInput,
  path?: string,
  now = Date.now(),
) {
  const input = workspaceNewsInputSchema.parse(raw);
  const window = {
    from: now - input.lookbackDays * 86400000,
    to: now,
    limit: input.limit,
  };
  const { terms, match } = workspaceMatcher(input);
  const items = terms.length
    ? queryWorkspaceNews(path ?? settings().clsDbPath, window, terms, match)
    : [];
  return { ...window, items };
}
export type WorkspaceNewsResult = ReturnType<typeof workspaceNews>;

function cleanSymbol(symbol: string) {
  return symbol.replace(/^cx/, "").toUpperCase();
}
function termsFor(
  symbol: string,
  nameOf: () => string | null | undefined = () => storedSecurityName(symbol),
) {
  const clean = cleanSymbol(symbol);
  if (clean === "BTCUSDT") return ["BTC", "比特币", "Bitcoin"];
  if (clean === "ETHUSDT") return ["ETH", "以太坊", "Ethereum"];
  return [
    ...new Set(
      [symbol, symbol.replace(/^(sh|sz|bj)/, ""), nameOf()].filter(
        (v): v is string => !!v && v.length >= 2,
      ),
    ),
  ];
}
type IntelSource = "position" | "plan";
type IntelTarget = {
  symbol: string;
  name: string | null;
  sources: IntelSource[];
  terms: string[];
};
/** One entry per normalized security. Every exact raw symbol keeps its own
 * terms and is name-looked-up at most once, including a missing (null) name;
 * the normalized key only merges display identity and sources. */
function intelTargets(
  rows: readonly { symbol: string; source: IntelSource }[],
): { targets: IntelTarget[]; terms: string[] } {
  const targets = new Map<string, IntelTarget>(),
    names = new Map<string, string | null>(),
    terms = new Set<string>();
  for (const { symbol, source } of rows) {
    const key = cleanSymbol(symbol);
    let target = targets.get(key);
    if (!target) {
      target = {
        symbol: symbol.replace(/^cx/, ""),
        name: null,
        sources: [],
        terms: [],
      };
      targets.set(key, target);
    }
    let name = names.get(symbol);
    if (name === undefined) {
      name =
        key === "BTCUSDT" || key === "ETHUSDT"
          ? null
          : (storedSecurityName(symbol) ?? null);
      names.set(symbol, name);
    }
    if (!target.name && name && name.length >= 2) target.name = name;
    // Keep the old query-term order: every raw symbol contributes its terms
    // when first encountered, even when its normalized display entry existed.
    for (const term of termsFor(symbol, () => name)) {
      if (!target.terms.includes(term)) target.terms.push(term);
      terms.add(term);
    }
    if (!target.sources.includes(source)) target.sources.push(source);
  }
  return { targets: [...targets.values()], terms: [...terms] };
}
/** Build the literal-term index once. Matching itself stays in SQLite; this
 * never re-reads or re-matches the truncated preview. */
function intelMatcher(targets: readonly IntelTarget[]) {
  const byTerm = new Map<string, IntelTarget[]>();
  for (const target of targets)
    for (const term of target.terms) {
      const list = byTerm.get(term) ?? [];
      if (!list.includes(target)) list.push(target);
      byTerm.set(term, list);
    }
  return (terms: readonly string[]) => {
    const matched = new Set<IntelTarget>();
    for (const term of terms)
      for (const target of byTerm.get(term) ?? []) matched.add(target);
    return targets.filter((target) => matched.has(target));
  };
}
export function intelEvents(input: {
  symbol: string;
  from: number;
  to: number;
}) {
  return relatedNewsEvents(
    settings().clsDbPath,
    termsFor(input.symbol),
    input.from,
    input.to,
  ).map((event) => ({
    ...event,
    sessionDate: new Date(
      Date.parse(event.publishedAt) +
        (input.symbol.startsWith("cx") ? 0 : 8 * 3600000),
    )
      .toISOString()
      .slice(0, 10),
  }));
}
export async function todayIntel(now = Date.now()) {
  const book = await loadAccountBook();
  const positionSymbols = book.positions
      .filter((p) => p.quantity > 0)
      .map((p) => p.symbol),
    planSymbols = new AlertRepository().plans(true).map((p) => p.symbol),
    symbols = [...new Set([...positionSymbols, ...planSymbols])],
    { targets, terms } = intelTargets([
      ...positionSymbols.map((symbol) => ({
        symbol,
        source: "position" as const,
      })),
      ...planSymbols.map((symbol) => ({ symbol, source: "plan" as const })),
    ]);
  const date = chinaClock(now).date,
    from = Date.parse(`${date}T00:00:00+08:00`),
    match = intelMatcher(targets);
  return {
    symbols,
    from,
    to: now,
    events: relatedNewsEvents(settings().clsDbPath, terms, from, now, true).map(
      ({ matches, ...event }) => ({
        ...event,
        matches: match(matches).map((target) => ({
          symbol: target.symbol,
          name: target.name,
          sources: target.sources,
        })),
      }),
    ),
    notice:
      "仅按已保存持仓及未完成计划的名称/代码匹配本地新闻；摘要为原文节选，不表示已核实利好利空。最多显示最近100条。",
  };
}
