import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type LimitPool = "zt" | "zb" | "dt" | "yzt";

/**
 * Client view state for 打板情绪. Server data stays in react-query (tRPC) and
 * the server-side cache; this store only remembers what the user was looking
 * at. The chosen pool persists across reloads; the date does not, so a fresh
 * session always opens on today.
 */
type LimitUpState = {
  date: string | null;
  pool: LimitPool;
  setDate: (date: string | null) => void;
  setPool: (pool: LimitPool) => void;
};

export const useLimitUpStore = create<LimitUpState>()(
  persist(
    (set) => ({
      date: null,
      pool: "zt",
      setDate: (date) => set({ date }),
      setPool: (pool) => set({ pool }),
    }),
    {
      name: "nq-limit-up",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ pool: state.pool }),
    },
  ),
);
