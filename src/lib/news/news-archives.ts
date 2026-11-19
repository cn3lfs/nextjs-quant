import {
  newsArchiveRoleLabel,
  newsPrimaryRoleLabel,
  type NewsArchiveRole,
} from "../settings/news-source-settings";

export { newsArchiveRoleLabel, newsPrimaryRoleLabel };
export type { NewsArchiveRole };

export type NewsArchiveKey = "primary" | "complement";
/** A source can be an explicit all/red archive or the primary's untyped material. */
export type NewsArchiveSourceRole = "unspecified" | NewsArchiveRole;
export type NewsArchiveOption = {
  key: NewsArchiveKey;
  role: NewsArchiveSourceRole;
  label: string;
  primary: boolean;
  available: boolean;
  message: string | null;
};
export type NewsArchiveOptions = {
  options: NewsArchiveOption[];
  unconfigured: { role: NewsArchiveRole; label: string }[];
  note: string | null;
};
export type NewsArchiveView = {
  key: NewsArchiveKey;
  role: NewsArchiveSourceRole;
  label: string;
  primary: boolean;
};
export type NewsArchiveSelection = NewsArchiveView & { path: string };
export function newsArchiveOptionLabel(role: NewsArchiveSourceRole) {
  return role === "unspecified"
    ? newsPrimaryRoleLabel.unspecified
    : newsArchiveRoleLabel[role];
}
export function newsArchiveSourceLabel(primary: boolean) {
  return primary ? "主档案" : "互补档案";
}
