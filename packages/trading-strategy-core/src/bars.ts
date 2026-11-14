export const periods = [
  "day",
  "week",
  "60m",
  "30m",
  "15m",
  "5m",
  "4h",
  "1h",
] as const;
export type Period = (typeof periods)[number];

export type Bar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
};
