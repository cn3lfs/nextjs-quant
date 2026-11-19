import { type Bar } from "~/lib/domain";
import { type AccountBook } from "./load-book";

export function calendarDays(dates: readonly string[]) {
  const ordered = [...new Set(dates.map((d) => d.slice(0, 10)))].sort();
  if (!ordered.length) return [];
  const start = Date.parse(ordered[0]!),
    end = Date.parse(ordered.at(-1)!);
  return Array.from(
    { length: Math.floor((end - start) / 86400000) + 1 },
    (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10),
  );
}
export function paperDailyBars(book: AccountBook, account: string) {
  const state = book.facts.paper.find((p) => p.account.id === account)?.state;
  return Object.fromEntries(
    (state?.request.instruments ?? []).map((i) => {
      const days = new Map<string, Bar>(),
        last = i.bars.at(-1)?.date;
      for (const b of i.bars) {
        const date = b.date.slice(0, 10);
        if (b.date.length > 10 && last && date === last.slice(0, 10)) continue;
        days.set(date, { ...b, date });
      }
      return [i.symbol, [...days.values()]];
    }),
  );
}
