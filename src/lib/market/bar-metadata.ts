import type { Market } from "./instrument";
export type BarMetadata = {
  version: "bar-store-1";
  priceRepaired?: boolean;
  availablePeriods?: import("../chart/chart-view").ChartPeriod[];
  market: Market;
  sourceFingerprint: string;
  sourceVersions: string[];
  adjustment: "none" | "forward" | "backward";
  adjustmentReference: string | null;
  adjustmentSource?: "local-gbbq" | "thsdk-native";
  coverage: {
    from: string | null;
    to: string | null;
    count: number;
    historyExhausted: boolean;
  };
  formingDates: string[];
  overlay: { source: string; date: string; completed: false } | null;
  excluded: { date: string; reason: string }[];
};
