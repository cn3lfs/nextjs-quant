import { z } from "zod";

const pathText = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => !value.includes("\0"), "路径不能包含空字符");
export const newsArchiveRoleSchema = z.enum(["all", "red"]);
export type NewsArchiveRole = z.infer<typeof newsArchiveRoleSchema>;
export const newsArchiveRoleLabel: Record<NewsArchiveRole, string> = {
  all: "全部电报",
  red: "加红电报",
};
export const newsPrimaryRoleLabel = {
  unspecified: "当前资料（未注明）",
  all: "全部电报",
  red: "加红电报",
} as const;
export const newsSourceSettingsSchema = z.object({
  clsDbPath: pathText.default(""),
  /** Declared by the user; never inferred from the path or row fields. */
  clsDbRole: z.enum(["unspecified", "all", "red"]).default("unspecified"),
  clsComplementDbPath: pathText.default(""),
  clsComplementDbRole: z.enum(["", "all", "red"]).default(""),
  newsPythonExecutable: pathText
    .refine((value) => value.length > 0, "请输入 Python 可执行文件或命令名")
    .default("python"),
});
export type NewsSourceSettings = z.infer<typeof newsSourceSettingsSchema>;
export type NewsArchiveSettings = Pick<
  NewsSourceSettings,
  "clsDbPath" | "clsDbRole" | "clsComplementDbPath" | "clsComplementDbRole"
>;
export function newsArchiveConfiguration(
  value: NewsArchiveSettings,
): NewsArchiveSettings {
  return {
    clsDbPath: value.clsDbPath,
    clsDbRole: value.clsDbRole,
    clsComplementDbPath: value.clsComplementDbPath,
    clsComplementDbRole: value.clsComplementDbRole,
  };
}
export function newsSourceConfiguration(
  value: NewsSourceSettings,
): NewsSourceSettings {
  return {
    ...newsArchiveConfiguration(value),
    newsPythonExecutable: value.newsPythonExecutable,
  };
}
const normalizedPath = (value: string) =>
  value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
export function newsSourceSettingsIssues(
  value: NewsSourceSettings,
): z.ZodIssue[] {
  const issues: z.ZodIssue[] = [];
  const add = (path: string, message: string) =>
    issues.push({ code: z.ZodIssueCode.custom, path: [path], message });
  if (value.clsDbRole !== "unspecified" && !value.clsDbPath)
    add("clsDbRole", "填写主档案路径后才能声明类型");
  if (value.clsComplementDbPath && !value.clsComplementDbRole)
    add("clsComplementDbRole", "请选择互补档案类型");
  if (!value.clsComplementDbPath && value.clsComplementDbRole)
    add("clsComplementDbPath", "填写互补档案路径后才能声明类型");
  if (value.clsComplementDbPath && !value.clsDbPath)
    add("clsDbPath", "配置互补档案前请先填写主档案路径");
  if (
    value.clsComplementDbPath &&
    value.clsComplementDbRole &&
    value.clsDbRole === value.clsComplementDbRole
  )
    add("clsComplementDbRole", "主档案与互补档案不能声明同一类型");
  if (
    value.clsDbPath &&
    value.clsComplementDbPath &&
    normalizedPath(value.clsDbPath) ===
      normalizedPath(value.clsComplementDbPath)
  )
    add("clsComplementDbPath", "主档案与互补档案不能是同一路径");
  return issues;
}
export const newsSourceSettingsRefinedSchema =
  newsSourceSettingsSchema.superRefine((value, context) => {
    for (const issue of newsSourceSettingsIssues(value))
      context.addIssue(issue);
  });
export type NewsSourceCheck = {
  configuration: NewsSourceSettings;
  checkedAt: number;
  database: { ok: boolean; message: string };
  python: { ok: boolean; message: string };
};
