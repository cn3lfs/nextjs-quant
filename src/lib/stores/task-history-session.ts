import { useMemo, type SetStateAction } from "react";
import { create } from "zustand";
import {
  taskHistoryHref,
  type TaskHistoryFilter,
} from "../research/workflow/task-history-location";

type Cursor = { createdAt: number; id: string };
type TaskHistoryView = {
  statusDraft: NonNullable<TaskHistoryFilter["status"]> | "all";
  typeDraft: NonNullable<TaskHistoryFilter["type"]> | "all";
  idDraft: string;
  cursors: (Cursor | undefined)[];
};
type CancelState = { pending?: boolean; error?: string; notice?: string };

// Only UI drafts, cursor history and in-flight feedback live here. Applied
// filters belong to the URL; server results stay in the query cache. A reload
// restores the shared filter and starts at page one, without persisting data.
export const useTaskSession = create<{
  views: Record<string, TaskHistoryView>;
  cancellations: Record<string, CancelState>;
  beginCancel: (id: string) => boolean;
  finishCancel: (id: string, result: CancelState) => void;
}>((set, get) => ({
  views: {},
  cancellations: {},
  beginCancel(id) {
    if (get().cancellations[id]?.pending) return false;
    set((state) => ({
      cancellations: { ...state.cancellations, [id]: { pending: true } },
    }));
    return true;
  },
  finishCancel(id, result) {
    set((state) => ({
      cancellations: { ...state.cancellations, [id]: result },
    }));
  },
}));

export function useTaskHistorySession(filter: TaskHistoryFilter) {
  const key = taskHistoryHref(filter);
  const initial = useMemo<TaskHistoryView>(
    () => ({
      statusDraft: filter.status ?? "all",
      typeDraft: filter.type ?? "all",
      idDraft: filter.id ?? "",
      cursors: [undefined],
    }),
    [key],
  );
  const view = useTaskSession((state) => state.views[key]) ?? initial;
  function update<K extends keyof TaskHistoryView>(
    field: K,
    value: SetStateAction<TaskHistoryView[K]>,
  ) {
    useTaskSession.setState((state) => {
      const current = state.views[key] ?? initial;
      return {
        views: {
          ...state.views,
          [key]: {
            ...current,
            [field]:
              typeof value === "function" ? value(current[field]) : value,
          },
        },
      };
    });
  }
  function reset(next: TaskHistoryFilter) {
    useTaskSession.setState((state) => ({
      views: {
        ...state.views,
        [taskHistoryHref(next)]: {
          statusDraft: next.status ?? "all",
          typeDraft: next.type ?? "all",
          idDraft: next.id ?? "",
          cursors: [undefined],
        },
      },
    }));
  }
  return { ...view, update, reset };
}
