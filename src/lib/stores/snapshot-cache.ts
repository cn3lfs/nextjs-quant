import { create } from "zustand";
import type { Snapshot } from "~/lib/domain";

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
  entries: Map<string, Snapshot>;
  get: (key: string) => Snapshot | undefined;
  put: (key: string, snapshot: Snapshot) => void;
  clear: () => void;
};

export const useSnapshotCache = create<SnapshotCacheState>()((set, getState) => ({
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
  clear: () => set({ entries: new Map() }),
}));
