import { z } from "zod";

const pathText = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => !value.includes("\0"), "路径不能包含空字符");
export const newsSourceSettingsSchema = z.object({
  clsDbPath: pathText.default(""),
  newsPythonExecutable: pathText
    .refine((value) => value.length > 0, "请输入 Python 可执行文件或命令名")
    .default("python"),
});
export type NewsSourceSettings = z.infer<typeof newsSourceSettingsSchema>;
export function newsSourceConfiguration(
  value: NewsSourceSettings,
): NewsSourceSettings {
  return {
    clsDbPath: value.clsDbPath,
    newsPythonExecutable: value.newsPythonExecutable,
  };
}
export type NewsSourceCheck = {
  configuration: NewsSourceSettings;
  checkedAt: number;
  database: { ok: boolean; message: string };
  python: { ok: boolean; message: string };
};
