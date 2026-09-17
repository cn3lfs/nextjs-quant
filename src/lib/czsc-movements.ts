import type { CzscRecursiveNode } from "./czsc";

export type ChanAnchor = 1 | 2 | 3;
export type ChanMovement = {
  id: number;
  level: number;
  type: -1 | 0 | 1;
  start: number;
  end: number;
  established: number;
  completed: number | null;
  successorId: number;
  centerIds: number[];
  connectionIds: number[];
  high: number;
  low: number;
};
export type ChanConnection = {
  id: number;
  leftId: number;
  rightId: number;
  level: number;
  start: number;
  end: number;
  required: number;
  space: 0 | 1;
  members: number[];
};
export type ChanAssociation = {
  id: number;
  structureId: number;
  movementId: number;
  completionId: number;
  level: number | null;
  status: "unknown" | "verified" | "ambiguous";
  centerIds: number[];
};
export type CzscMovements = {
  version: "native-movements-c4-1";
  anchor: ChanAnchor;
  config: 0 | 1100;
  centers: CzscRecursiveNode[];
  movements: ChanMovement[];
  connections: ChanConnection[];
  associations: ChanAssociation[];
};

export const chanMovementOutputs = [
  100, 101, 102, 103, 104, 105, 106, 107, 108,
];
/** Negative extension prevents output100 from becoming config1/output0. */
export function chanProjectionMode(config: number, output: number) {
  if (
    ![0, 1100].includes(config) ||
    !Number.isInteger(output) ||
    output < 0 ||
    output > 108
  )
    throw new RangeError("Invalid CZSC output/config");
  return output >= 100
    ? -(config * 10000 + output * 10)
    : config * 1000 + output * 10;
}

/** Validate explicit period identity; monthly bars must already be calendar-complete. */
export function chanAnchorDateCodes(
  dates: readonly string[],
  anchor: ChanAnchor,
) {
  if (![1, 2, 3].includes(anchor)) throw new Error("未知锚契约");
  return dates.map((date, i) => {
    const day = date.slice(0, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(day).toISOString().slice(0, 10) !== day ||
      (i > 0 && date <= dates[i - 1]!) ||
      (anchor !== 2 && date !== day) ||
      (anchor === 3 && i > 0 && date.slice(0, 7) <= dates[i - 1]!.slice(0, 7))
    )
      throw new Error("锚周期、日期顺序或月份无效");
    if (anchor === 2) {
      const minute =
        Number(date.slice(11, 13)) * 60 + Number(date.slice(14, 16));
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(date) ||
        minute % 5 ||
        !((minute >= 575 && minute <= 690) || (minute >= 785 && minute <= 900))
      )
        throw new Error("五分钟锚必须使用交易时段已结束五分钟K线的上海时戳");
      if (day < "2000-01-04" || day > "2022-11-30")
        throw new Error("五分钟窗口须为2000-01-04..2022-11-30");
    }
    const code = Number(day.replaceAll("-", "")) - 20000000;
    if (code < -1000000 || code > 1991231)
      throw new Error("锚日期超出1900..2199");
    return code;
  });
}
