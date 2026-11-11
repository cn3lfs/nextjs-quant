import { z } from "zod";
export const asOfTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "时间或时区偏移无效");
