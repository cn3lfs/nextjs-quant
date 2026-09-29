import { create } from "zustand";
import type { Snapshot } from "~/lib/domain";
import { isCryptoSymbol } from "~/lib/market/crypto";
import { isFuturesSymbol } from "~/lib/market/futures";

/**
 * Recently viewed chart snapshots, in memory only (bars are too large to
 * persist). Snapshot ids are derived from content, so a reload that returns
 * the same id means nothing changed and the chart need not re-render.
 */
export type SnapshotRequest = {
  symbol: string;
  period: string;
  source?: string;
  futuresSource?: string;
  cryptoSource?: string;
};
export const snapshotCacheKey = (r: SnapshotRequest) =>
  [r.symbol, r.period, r.source ?? "", r.futuresSource ?? ""].join("|") +
  (r.cryptoSource ? `|${r.cryptoSource}` : "");

const LIMIT = 12;

type SnapshotCacheState = {
  generation: number;
  marketGeneration: number;
  entries: Map<string, Snapshot>;
  get: (key: string) => Snapshot | undefined;
  put: (key: string, snapshot: Snapshot) => void;
  clear: () => void;
  clearMarket: () => void;
};

export const useSnapshotCache = create<SnapshotCacheState>()(
  (set, getState) => ({
    generation: 0,
    marketGeneration: 0,
    entries: new Map(),
    get: (key) => getState().entries.get(key),
    put: (key, snapshot) =>
      set(({ entries }) => {
        const next = new Map(entries);
        next.delete(key);
        next.set(key, snapshot);
        // Map keeps insertion order: the first key is the least recently used.
        while (next.size > LIMIT) next.delete(next.keys().next().value!);
        return { entries: next };
      }),
    clear: () =>
      set((state) => ({
        entries: new Map(),
        generation: state.generation + 1,
      })),
    clearMarket: () =>
      set((state) => ({
        entries: new Map(
          [...state.entries].filter(
            ([, snapshot]) =>
              isCryptoSymbol(snapshot.symbol) ||
              isFuturesSymbol(snapshot.symbol),
          ),
        ),
        marketGeneration: state.marketGeneration + 1,
      })),
  }),
);
