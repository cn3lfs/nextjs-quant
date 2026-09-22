import { atomic } from "../../db";
import {
  downloadDailyIncrement,
  extractDailyIncrement,
} from "./tdx-increment-download";
import { publishDailyIncrement } from "./tdx-daily-cache";
import { symbolSchema } from "~/lib/domain";

/** All selected markets publish together; download/extraction never touch TDX files. */
export async function refreshDailyIncrement(
  date: string,
  symbols: string[],
  checkpoint: () => void = () => {},
  options: { allowUnavailable?: boolean } = {},
) {
  if (!symbols.length || new Set(symbols).size !== symbols.length)
    throw new Error("增量证券清单为空或重复");
  symbols.forEach((symbol) => symbolSchema.parse(symbol));
  checkpoint();
  const downloaded = await downloadDailyIncrement(date);
  if (downloaded.status === "not-published") return downloaded;
  const packages = await extractDailyIncrement(downloaded.bytes, date);
  const snapshots = atomic(() => {
    checkpoint();
    return packages.flatMap((pack) => {
      const selected = symbols.filter((symbol) =>
        symbol.startsWith(pack.market),
      );
      return selected.length
        ? [
            publishDailyIncrement({
              ...pack,
              date,
              symbols: selected,
              observedAt: downloaded.observedAt,
              allowUnavailable: options.allowUnavailable,
            }),
          ]
        : [];
    });
  });
  return {
    status: snapshots.some((snapshot) => snapshot.unavailable.length)
      ? ("partial" as const)
      : ("published" as const),
    date,
    packageHash: downloaded.hash,
    snapshots,
  };
}
