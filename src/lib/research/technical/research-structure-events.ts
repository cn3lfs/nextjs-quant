/** Append-only observations. A confirmation never rewrites its candidate row. */
export type StructureEvent<T> = {
  key: string;
  kind: string;
  candidateAt: string;
  observedAt: string;
  confirmedAt: string | null;
  state: "candidate" | "confirmed" | "cancelled";
  reason: string;
  facts: T;
};
export type ResearchStructureObservation = {
  symbol: string;
  date: string;
  warmup: boolean;
  reason: string | null;
  events: StructureEvent<unknown>[];
  values?: unknown;
  structure?: unknown;
};
export function structureEventMachine<T>() {
  const pending = new Map<string, StructureEvent<T>>();
  const used = new Set<string>();
  let lastAt = "";
  return {
    observe(
      at: string,
      candidates: { key: string; kind: string; facts: T }[],
      decide: (event: Readonly<StructureEvent<T>>) => {
        state: "confirmed" | "cancelled" | "waiting";
        reason: string;
      },
      unavailable: string | null = null,
    ): StructureEvent<T>[] {
      if (at <= lastAt) throw new Error("结构事件观察时间必须严格递增");
      lastAt = at;
      const rows: StructureEvent<T>[] = [];
      for (const [key, candidate] of pending) {
        const result = unavailable
          ? { state: "cancelled" as const, reason: unavailable }
          : decide(structuredClone(candidate));
        if (result.state === "waiting") continue;
        rows.push({
          ...structuredClone(candidate),
          observedAt: at,
          confirmedAt: result.state === "confirmed" ? at : null,
          state: result.state,
          reason: result.reason,
        });
        pending.delete(key);
      }
      if (!unavailable)
        for (const candidate of candidates) {
          if (used.has(candidate.key)) continue;
          used.add(candidate.key);
          const row: StructureEvent<T> = {
            ...structuredClone(candidate),
            candidateAt: at,
            observedAt: at,
            confirmedAt: null,
            state: "candidate",
            reason: "等待后续观察确认",
          };
          pending.set(candidate.key, structuredClone(row));
          rows.push(row);
        }
      return rows;
    },
  };
}
