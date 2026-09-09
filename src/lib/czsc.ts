export interface CzscPoint {
  index: number;
  date: string;
  direction: number;
  price: number;
}
export interface CzscCenter {
  start: number;
  end: number;
  startDate: string;
  endDate: string;
  direction: number;
  ZG: number;
  ZD: number;
  GG: number;
  DD: number;
}
export interface CzscFamily {
  config: 0 | 1100;
  points: CzscPoint[];
  centers: CzscCenter[];
  signals: {
    index: number;
    date: string;
    kind: number;
    quality: number;
    centerId?: number;
    divergence?: {
      areaRatio: number;
      priceRatio: number;
      speedRatio: number;
      flags: number;
      semantic: number;
    };
  }[];
  // Output 23 describes the movement belonging to each signal, not every bar.
  movements: { index: number; direction: number }[];
  qualities: { index: number; value: number }[];
  divergences: { start: number; end: number; direction: number }[];
}
export interface CzscSignalDetails {
  strategyVersion: "czsc-monitor-1";
  dllVersion: string;
  config: 0 | 1100;
  points: {
    key: string;
    date: string;
    kind: number;
    quality: number;
    center: CzscCenter | null;
    divergence: string;
    invalidation: string;
  }[];
}
export interface CzscResult {
  status: "structure" | "no-structure";
  hash: string;
  sourceCommit: "b67f3c6";
  families: CzscFamily[];
}
