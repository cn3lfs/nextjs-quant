import { expect, it } from "vitest";
import {
  bigFloor,
  bpsOf,
  moneyMul,
  toNumber,
  big,
  bigMin,
} from "../src/lib/money";

it("bigFloor 与 Math.floor 逐项一致，含负数与边界", () => {
  for (const value of [
    0, 1, 1.5, 2.999, 100, -0.0001, -0.5, -1, -1.5, -2.999, 1e-20, -1e-20,
  ])
    expect(bigFloor(value), String(value)).toBe(Math.floor(value));
  // 字符串与 Big 输入同样接受，且不引入二进制浮点中间值。
  expect(bigFloor("-1.5")).toBe(-2);
  expect(bigFloor(big("-1.5"))).toBe(-2);
});

it("bps 与乘法给出精确十进制，不留浮点渣", () => {
  // 0.1+0.2 式的经典误差：裸浮点 100.1 * 3 得 300.29999999999995。
  expect(moneyMul(100.1, 3)).toBe(300.3);
  expect(bpsOf(1000, 3)).toBe(0.3);
  expect(bpsOf("13.0065", 5)).toBe(0.00650325);
  expect(toNumber(bigMin(3, 1.5, 2))).toBe(1.5);
});
