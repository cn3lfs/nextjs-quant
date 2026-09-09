import { z } from "zod";
export const screenSortSchema = z.enum([
  "original",
  "symbol",
  "close",
  "change",
  "volumeRatio",
  "score",
]);
export type ScreenSort = z.infer<typeof screenSortSchema>;
export const screenSortLabels: Record<ScreenSort, string> = {
  original: "原始顺序",
  symbol: "证券代码",
  close: "收盘价",
  change: "涨跌幅",
  volumeRatio: "量比",
  score: "趋势分",
};
