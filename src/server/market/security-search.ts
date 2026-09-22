import { pinyin } from "pinyin-pro";
import type { Security, Period } from "~/lib/domain";
const aliases = new Map<string, string[]>();
const normalize = (value: string) => value.toLowerCase().replace(/\s/g, "");
export function searchSecurities(
  securities: Security[],
  query: string,
  period: Period,
) {
  const needle = normalize(query);
  return securities
    .filter((item) => item.period === period)
    .map((item) => {
      let keys = aliases.get(item.name);
      if (!keys) {
        const syllables = pinyin(item.name, {
          toneType: "none",
          type: "array",
        });
        keys = [
          normalize(item.name),
          normalize(syllables.join("")),
          normalize(syllables.map((s) => s[0]).join("")),
        ];
        aliases.set(item.name, keys);
      }
      const values = [item.symbol, item.symbol.slice(2), ...keys];
      const rank = !needle
        ? 3
        : values.some((v) => v === needle)
          ? 0
          : values.some((v) => v.startsWith(needle))
            ? 1
            : values.some((v) => v.includes(needle))
              ? 2
              : 9;
      return { item, rank };
    })
    .filter((r) => r.rank < 9)
    .sort(
      (a, b) => a.rank - b.rank || a.item.symbol.localeCompare(b.item.symbol),
    )
    .slice(0, 100)
    .map(({ item }) => item);
}
