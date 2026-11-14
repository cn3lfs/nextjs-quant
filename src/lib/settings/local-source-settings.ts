import { z } from "zod";

/** Blank means unconfigured; paths are checked for readability by the server. */
export const localDirectorySchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) =>
      !value.includes("\0") &&
      (value === "" ||
        /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+|\/(?!\/))/i.test(value)),
    "请输入绝对目录路径，或留空表示未配置。",
  );
