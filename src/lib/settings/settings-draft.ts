import type { Settings } from "~/lib/domain";

/** Only fields owned by the general settings form. Other panels own the rest. */
export const connectionSettingKeys = [
  "tdxRoot",
  "clsDbPath",
  "marketDataSource",
  "calendar",
  "llmProvider",
  "codexModel",
  "claudeModel",
  "fastModel",
  "deepModel",
  "analysisLimit",
  "autoAnalysis",
  "autoNewsAnalysis",
  "autoNewsDailyBatches",
  "proxy",
  "notificationPolicy",
] as const satisfies readonly (keyof Settings)[];

export function sameSetting(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type SettingsDraftState = { base: Settings; draft: Settings };

/** Adopt untouched remote fields, retaining explicit local edits. */
export function reconcileSettings(
  state: SettingsDraftState,
  incoming: Settings,
): SettingsDraftState {
  const edits = Object.fromEntries(
    connectionSettingKeys
      .filter((key) => !sameSetting(state.draft[key], state.base[key]))
      .map((key) => [key, state.draft[key]]),
  );
  return { base: incoming, draft: { ...incoming, ...edits } };
}

/** A response acknowledges the submitted values, not edits made while saving. */
export function acknowledgeSettings(
  state: SettingsDraftState,
  submitted: Settings,
  original: Settings = submitted,
): SettingsDraftState {
  const normalized = Object.fromEntries(
    connectionSettingKeys
      .filter((key) => sameSetting(state.draft[key], original[key]))
      .map((key) => [key, submitted[key]]),
  );
  return { base: submitted, draft: { ...state.draft, ...normalized } };
}

export function changedSettings(state: SettingsDraftState) {
  return connectionSettingKeys.filter(
    (key) => !sameSetting(state.draft[key], state.base[key]),
  );
}

export function settingsToSave(
  state: SettingsDraftState,
  current: Settings,
): Settings {
  return {
    ...current,
    ...Object.fromEntries(
      connectionSettingKeys.map((key) => [key, state.draft[key]]),
    ),
  };
}
