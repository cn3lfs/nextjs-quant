import { relatedNewsEvents } from "../db/news-workspace-query";
import { settings } from "../infra/settings";
import { storedSecurityName } from "../market/securities";
import { loadAccountBook } from "../portfolio/account-workspace-service";
import { AlertRepository } from "../db/alert-repository";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";

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
