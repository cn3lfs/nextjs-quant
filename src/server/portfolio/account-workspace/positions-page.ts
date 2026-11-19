import {
  accountPageSchema,
  positionMetrics,
  industryGroupsFor,
  stopStatusFor,
  type AccountPosition,
} from "~/lib/portfolio/account-workspace";
import { type AccountBook } from "./load-book";
import { reconcileRealHoldings } from "./reconciliation";

export function pageAccountBook(book: AccountBook, raw: unknown) {
  const input = accountPageSchema.parse(raw);
  // Delivery vs manual ledger is fixed by the position id prefix built below,
  // never by the mutable account display name. Non-real kinds have no source.
  const source = input.kind === "real" ? input.source : "all";
  const scope = book.positions.filter(
    (p) =>
      (input.kind === "all" || p.kind === input.kind) &&
      (input.market === "all" || p.market === input.market) &&
      (!input.sleeve || p.sleeve === input.sleeve) &&
      (input.stopStatus === "all" || stopStatusFor(p) === input.stopStatus),
  );
  const positions = scope
    .filter((p) => source === "all" || p.id.startsWith(source + ":"))
    .sort(
      (a, b) =>
        String(a[input.group]).localeCompare(String(b[input.group])) ||
        a.account.localeCompare(b.account) ||
        a.id.localeCompare(b.id),
    );
  const totals = (["CNY", "USDT"] as const).map((currency) => {
    const rows = positions.filter((p) => p.currency === currency);
    return {
      currency,
      count: rows.length,
      value: rows.every((p) => p.value !== null)
        ? rows.reduce((n, p) => n + p.value!, 0)
        : null,
      missing: rows.filter((p) => p.value === null).length,
    };
  });
  const groupNames = (
    position: AccountPosition,
    dimension: "market" | "sleeve" | "industry",
  ) => {
    if (dimension !== "industry") return [position[dimension]];
    const names = industryGroupsFor(position);
    return names.length ? names : ["未知"];
  };
  const exposure = (["market", "sleeve", "industry"] as const).flatMap(
    (dimension) =>
      [
        ...new Set(
          positions.flatMap((p) =>
            groupNames(p, dimension).map((group) => `${p.currency}:${group}`),
          ),
        ),
      ].map((key) => {
        const rows = positions.filter((p) =>
          groupNames(p, dimension).some(
            (group) => `${p.currency}:${group}` === key,
          ),
        );
        return {
          dimension,
          overlapping: dimension === "industry",
          key,
          value: rows.every((p) => p.value !== null)
            ? rows.reduce((n, p) => n + p.value!, 0)
            : null,
        };
      }),
  );
  return {
    total: positions.length,
    reconciliation: reconcileRealHoldings(
      scope,
      new Map(book.facts.fills.map((f) => [f.symbol ?? f.code, f.name])),
    ),
    totals,
    exposure,
    industrySource: book.industrySource,
    items: positions
      .slice(input.page * 20, (input.page + 1) * 20)
      .map((p) => ({ ...p, ...positionMetrics(p) })),
    missingAccounts: book.facts.crypto
      .filter((c) => !c.snapshot)
      .map((c) => `${c.bot.id} 尚无完整钱包快照`),
  };
}
