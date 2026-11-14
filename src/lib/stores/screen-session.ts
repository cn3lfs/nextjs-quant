import { create } from "zustand";
import type { ScreenSort } from "~/lib/screening/screen-sort";

type ScreenSession = {
  screenId: string;
  screenPage: number;
  excludedPage: number;
  errorPage: number;
  screenQuery: string;
  screenSort: ScreenSort;
  screenDirection: "asc" | "desc";
  selectJob: (id: string) => void;
  setScreenPage: (page: number) => void;
  setExcludedPage: (page: number) => void;
  setErrorPage: (page: number) => void;
  setScreenQuery: (query: string) => void;
  setScreenSort: (sort: ScreenSort) => void;
  setScreenDirection: (direction: "asc" | "desc") => void;
};

// Session-only controls survive panel-cache eviction. Results stay in the query
// cache; only screening subscribes, so pagination cannot rerender the shell.
export const useScreenSession = create<ScreenSession>((set) => ({
  screenId: "",
  screenPage: 0,
  excludedPage: 0,
  errorPage: 0,
  screenQuery: "",
  screenSort: "original",
  screenDirection: "desc",
  selectJob: (screenId) =>
    set((state) =>
      state.screenId === screenId
        ? state
        : {
            screenId,
            screenPage: 0,
            excludedPage: 0,
            errorPage: 0,
            screenQuery: "",
            screenSort: "original",
          },
    ),
  setScreenPage: (screenPage) => set({ screenPage }),
  setExcludedPage: (excludedPage) => set({ excludedPage }),
  setErrorPage: (errorPage) => set({ errorPage }),
  setScreenQuery: (screenQuery) => set({ screenQuery }),
  setScreenSort: (screenSort) => set({ screenSort }),
  setScreenDirection: (screenDirection) => set({ screenDirection }),
}));
