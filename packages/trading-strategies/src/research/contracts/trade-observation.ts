/** Only completed trade observations consumed by calibration, never an account writer. */
export type StopCalibrationTrade = {
  event: {
    partition: string;
    observedDate: string;
    symbol: string;
    key: string;
    strategyVersion: string;
  };
  entryDate: string;
  exitDate: string | null;
  entryPrice: number;
  exitPrice: number | null;
  initialStop?: number | null;
  quantity: number;
  profit: number | null;
  entries?: readonly unknown[];
  sales?: readonly unknown[];
  remainingQuantity?: number;
  exitReason?: string | null;
};
export type StopFrequencyTrade = {
  entryDate: string;
  exitDate: string | null;
  profit: number | null;
  exitReason?: string | null;
};
