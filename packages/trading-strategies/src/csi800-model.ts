import type { Bar } from "trading-strategy-core/bars";
export type Csi800Stock = {
  symbol: string;
  bars: Bar[];
  signalBars?: Bar[];
  actions: {
    date: string;
    dividend: number;
    bonus: number;
    rights?: number;
    rightsPrice?: number;
    unsupported: boolean;
  }[];
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Iterative capped allocation. Unallocatable capital stays in cash. */
export function csi800Weights(scores: number[], exposure: number) {
  if (
    !Number.isFinite(exposure) ||
    exposure < 0 ||
    exposure > 1 ||
    scores.some((v) => !Number.isFinite(v) || v <= 0)
  )
    throw new Error("权重输入非法");
  const weights = scores.map(() => 0);
  let remaining = exposure;
  let active = scores.map((_, i) => i);
  while (active.length && remaining > 1e-12) {
    const total = sum(active.map((i) => scores[i]!));
    const capped = active.filter(
      (i) => (remaining * scores[i]!) / total >= 0.15,
    );
    if (!capped.length) {
      for (const i of active) weights[i] = (remaining * scores[i]!) / total;
      break;
    }
    for (const i of capped) {
      weights[i] = 0.15;
      remaining -= 0.15;
    }
    active = active.filter((i) => !capped.includes(i));
  }
  return weights;
}

export type Csi800Allocation = {
  date: string;
  weights: Record<string, number>;
};
