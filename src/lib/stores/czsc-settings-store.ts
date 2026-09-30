import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  defaultCzscSettings,
  type CzscSettings,
} from "~/lib/chart/czsc-settings";

/**
 * 缠论结构指标的图表设置，跨品种、跨周期共享并持久化。
 * 结构口径（笔/收笔/线段）送 DLL；显示项只影响绘制。
 */
type CzscSettingsState = CzscSettings & {
  /** Center box spans the first three members (lessons 17/18) or the full extension. */
  box: "initial" | "extended";
  showStroke: boolean;
  showSegment: boolean;
  set: (patch: Partial<Omit<CzscSettingsState, "set" | "reset">>) => void;
  reset: () => void;
};

const display = {
  box: "initial" as const,
  showStroke: true,
  showSegment: true,
};

export const useCzscSettings = create<CzscSettingsState>()(
  persist(
    (set) => ({
      ...defaultCzscSettings,
      ...display,
      set: (patch) => set(patch),
      reset: () => set({ ...defaultCzscSettings, ...display }),
    }),
    {
      name: "nq-czsc-settings",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ set: _set, reset: _reset, ...state }) => state,
    },
  ),
);
