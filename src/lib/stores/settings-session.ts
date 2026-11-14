import { create } from "zustand";
import type { SettingsDraftState } from "~/lib/settings/settings-draft";

// Memory only: do not write settings/credentials to browser storage.
export const useSettingsSession = create<{
  draft: SettingsDraftState | null;
  update: (
    initial: SettingsDraftState,
    change: (state: SettingsDraftState) => SettingsDraftState,
  ) => void;
}>((set) => ({
  draft: null,
  update: (initial, change) =>
    set((state) => ({ draft: change(state.draft ?? initial) })),
}));
