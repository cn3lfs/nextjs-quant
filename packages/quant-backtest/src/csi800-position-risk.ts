export type PositionRiskStage = "initial" | "breakeven" | "partial" | "full";
export type PositionRiskState = {
  openedAt: string;
  entryEquity: number;
  budget: number;
  cost: number;
  capitalPerShare: number;
  realized: number;
  hardStop: number | null;
  breakEvenStop: number | null;
  trimArmed: boolean;
  trimRemaining: number;
  exitPending: boolean;
  exitTriggeredAt: string | null;
  exitTriggerReasons: string[];
  trimTriggeredAt: string | null;
};
export function createPositionRisk(
  date: string,
  equity: number,
): PositionRiskState {
  if (!Number.isFinite(equity) || equity <= 0)
    throw new Error("单笔风险入场权益非法");
  return {
    openedAt: date,
    entryEquity: equity,
    budget: equity * 0.02,
    cost: 0,
    capitalPerShare: 0,
    realized: 0,
    hardStop: null,
    breakEvenStop: null,
    trimArmed: false,
    trimRemaining: 0,
    exitPending: false,
    exitTriggeredAt: null,
    exitTriggerReasons: [],
    trimTriggeredAt: null,
  };
}
export function positionRiskBuy(
  state: PositionRiskState,
  before: number,
  quantity: number,
  price: number,
  fee: number,
) {
  const unit = price + fee / quantity;
  state.cost = (state.cost * before + unit * quantity) / (before + quantity);
  state.capitalPerShare =
    (state.capitalPerShare * before + unit * quantity) / (before + quantity);
}
export function positionRiskSell(
  state: PositionRiskState,
  quantity: number,
  price: number,
  fee: number,
) {
  state.realized += quantity * (price - state.cost) - fee;
  if (state.trimArmed)
    state.trimRemaining = Math.max(0, state.trimRemaining - quantity);
}
export function positionRiskAction(
  state: PositionRiskState,
  action: {
    dividend: number;
    bonus: number;
    rights?: number;
    rightsPrice?: number;
  },
) {
  const subscription = (action.rights ?? 0) * (action.rightsPrice ?? 0);
  const multiplier = 1 + action.bonus + (action.rights ?? 0);
  state.cost = (state.cost - action.dividend + subscription) / multiplier;
  state.capitalPerShare = (state.capitalPerShare + subscription) / multiplier;
  for (const key of ["hardStop", "breakEvenStop"] as const) {
    if (state[key] !== null)
      state[key] = (state[key]! - action.dividend + subscription) / multiplier;
  }
  state.trimRemaining *= multiplier;
}
/** Planned loss at the existing protection after a proposed opening purchase. */
export function positionRiskPlannedLoss(
  state: PositionRiskState | undefined,
  before: number,
  quantity: number,
  price: number,
  buyFee: number,
  exitFee: number,
) {
  const cost =
    ((state?.cost ?? 0) * before + quantity * price + buyFee) /
    (before + quantity);
  const capital =
    ((state?.capitalPerShare ?? 0) * before + quantity * price + buyFee) /
    (before + quantity);
  const stop = Math.max(
    state?.hardStop ?? -Infinity,
    state?.breakEvenStop ?? -Infinity,
    cost - 0.08 * capital,
  );
  return Math.max(
    0,
    -(state?.realized ?? 0) + (before + quantity) * (cost - stop) + exitFee,
  );
}
export function evaluatePositionClose(
  state: PositionRiskState,
  input: {
    date: string;
    close: number;
    quantity: number;
    exitFee: number;
    ema50: number | null;
    stage: PositionRiskStage;
    sellStep: number;
    minimumPartial: number;
  },
) {
  const { close, quantity, exitFee, ema50, stage, sellStep, minimumPartial } =
    input;
  if (
    ![
      close,
      quantity,
      exitFee,
      state.cost,
      state.capitalPerShare,
      state.realized,
    ].every(Number.isFinite) ||
    close <= 0 ||
    quantity <= 0 ||
    state.capitalPerShare <= 0
  )
    throw new Error("收盘风控状态非法");
  const gain = (close - state.cost) / state.capitalPerShare;
  const pnl = state.realized + quantity * (close - state.cost) - exitFee;
  const stop8 = state.cost - 0.08 * state.capitalPerShare;
  const stop2 =
    state.cost + (-state.budget - state.realized + exitFee) / quantity;
  state.hardStop = Math.max(state.hardStop ?? -Infinity, stop8, stop2);
  if (
    stage !== "initial" &&
    (state.breakEvenStop !== null || gain >= 0.05 - 1e-12)
  )
    state.breakEvenStop = Math.max(
      state.breakEvenStop ?? -Infinity,
      state.cost,
    );
  const emaProtection =
    stage === "full" && ema50 !== null && Number.isFinite(ema50) && ema50 > 0
      ? ema50
      : null;
  const reasons: string[] = [];
  if (close <= state.hardStop + 1e-12) reasons.push("initial-or-account-stop");
  if (pnl <= -state.budget + 1e-8) reasons.push("account-risk-2pct");
  if (state.breakEvenStop !== null && close <= state.breakEvenStop + 1e-12)
    reasons.push("breakeven-stop");
  if (emaProtection !== null && close < emaProtection - 1e-12)
    reasons.push("ema50-stop");
  if (reasons.length && !state.exitPending) {
    state.exitTriggeredAt = input.date;
    state.exitTriggerReasons = [...reasons];
    state.exitPending = true;
  }
  if (state.exitPending && !reasons.length) reasons.push("pending-risk-exit");
  let insufficientLot = false;
  if (
    !state.exitPending &&
    ["partial", "full"].includes(stage) &&
    gain >= 0.3 - 1e-12 &&
    !state.trimArmed
  ) {
    state.trimArmed = true;
    state.trimTriggeredAt = input.date;
    state.trimRemaining = Math.floor(quantity / 3 / sellStep) * sellStep;
    if (state.trimRemaining < minimumPartial) {
      state.trimRemaining = 0;
      insufficientLot = true;
    }
  }
  const requested = state.exitPending
    ? quantity
    : Math.min(quantity, state.trimRemaining);
  return {
    gain,
    pnl,
    stop8,
    stop2,
    protection: Math.max(
      state.hardStop,
      state.breakEvenStop ?? -Infinity,
      emaProtection ?? -Infinity,
    ),
    requested,
    action: state.exitPending
      ? ("exit" as const)
      : requested > 0
        ? ("trim" as const)
        : ("hold" as const),
    reasons,
    insufficientLot,
  };
}
