import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { CzscSettings } from "~/lib/chart/czsc-settings";

/**
 * 缠论结构指标的图表设置，跨品种、跨周期共享并持久化。
 * `values` 以 DLL 配置字段 key 保存（分析口径与显示投影）；未设置的字段用 DLL 默认值。
 * 笔级/线段级的显示开关只影响绘制，不送 DLL。
 */
type CzscSettingsState = {
  values: CzscSettings;
  showStroke: boolean;
  showSegment: boolean;
  setValue: (key: string, value: number) => void;
  set: (patch: { showStroke?: boolean; showSegment?: boolean }) => void;
  reset: () => void;
};

/** Chart defaults that differ from the DLL's: the box ends at the first three members. */
export const chartCzscDefaults: CzscSettings = { "projection.centerBox": 0 };

const initial = {
  values: chartCzscDefaults,
  showStroke: true,
  showSegment: true,
};

/** Pre-v20 persisted shape (decimal config digits kept as separate fields). */
type LegacyState = {
  stroke?: number;
  strokeEnd?: number;
  segment?: number;
  segmentEnd?: number;
  centerMode?: number;
  box?: "initial" | "extended";
  showStroke?: boolean;
  showSegment?: boolean;
};

export function migrateLegacy(old: LegacyState) {
  const values: CzscSettings = { ...chartCzscDefaults };
  const map: [keyof LegacyState, string][] = [
    ["stroke", "stroke.rule"],
    ["strokeEnd", "stroke.endpoint"],
    ["segment", "segment.method"],
    ["segmentEnd", "projection.segmentBoundary"],
    ["centerMode", "center.strokeFormation"],
  ];
  for (const [from, to] of map)
    if (typeof old[from] === "number") values[to] = old[from];
  if (old.box) values["projection.centerBox"] = old.box === "initial" ? 0 : 1;
  return {
    values,
    showStroke: old.showStroke ?? true,
    showSegment: old.showSegment ?? true,
  };
}

export const useCzscSettings = create<CzscSettingsState>()(
  persist(
    (set) => ({
      ...initial,
      setValue: (key, value) =>
        set((state) => ({ values: { ...state.values, [key]: value } })),
      set: (patch) => set(patch),
      reset: () => set(initial),
    }),
    {
      name: "nq-czsc-settings",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) =>
        version < 1
          ? migrateLegacy(persisted as LegacyState)
          : (persisted as typeof initial),
      partialize: ({ values, showStroke, showSegment }) => ({
        values,
        showStroke,
        showSegment,
      }),
    },
  ),
);
