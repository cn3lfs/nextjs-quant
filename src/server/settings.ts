import { get, put } from "./db";
import { settingsSchema, type Settings } from "~/lib/domain";
export function settings(): Settings {
  return settingsSchema.parse(get("settings") ?? {});
}
export function saveSettings(value: Settings) {
  return put("settings", "settings", settingsSchema.parse(value));
}
