import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  breakoutChartSettingsSchema,
  defaultBreakoutChartSettings,
  defaultPatternBreakoutChartSettings,
  patternBreakoutChartSettingsSchema,
  type BreakoutChartSettings,
  type PatternBreakoutChartSettings,
} from "~/lib/chart/overlay-settings";

type OverlaySettingsState = {
  breakout: BreakoutChartSettings;
  patternBreakout: PatternBreakoutChartSettings;
  setBreakout: (patch: Partial<BreakoutChartSettings>) => void;
  resetBreakout: () => void;
  setPatternBreakout: (patch: Partial<PatternBreakoutChartSettings>) => void;
  resetPatternBreakout: () => void;
};

export const useOverlaySettings = create<OverlaySettingsState>()(
  persist(
    (set) => ({
      breakout: defaultBreakoutChartSettings,
      patternBreakout: defaultPatternBreakoutChartSettings,
      setBreakout: (patch) =>
        set(({ breakout }) => ({
          breakout: breakoutChartSettingsSchema.parse({
            ...breakout,
            ...patch,
          }),
        })),
      resetBreakout: () => set({ breakout: defaultBreakoutChartSettings }),
      setPatternBreakout: (patch) =>
        set(({ patternBreakout }) => ({
          patternBreakout: patternBreakoutChartSettingsSchema.parse({
            ...patternBreakout,
            ...patch,
          }),
        })),
      resetPatternBreakout: () =>
        set({ patternBreakout: defaultPatternBreakoutChartSettings }),
    }),
    {
      name: "nq-chart-overlay-settings",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ breakout, patternBreakout }) => ({
        breakout,
        patternBreakout,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<OverlaySettingsState> | undefined;
        const breakout = breakoutChartSettingsSchema.safeParse(saved?.breakout);
        const pattern = patternBreakoutChartSettingsSchema.safeParse(
          saved?.patternBreakout,
        );
        return {
          ...current,
          breakout: breakout.success ? breakout.data : current.breakout,
          patternBreakout: pattern.success
            ? pattern.data
            : current.patternBreakout,
        };
      },
    },
  ),
);
