// Synthetic scale only; these trades do not represent achievable strategy returns.
export const r13Days = Array.from(
  { length: 1800 },
  (_, i) => new Date(Date.UTC(2021, 0, 1 + i)),
)
  .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
  .slice(0, 1265)
  .map((d) => d.toISOString().slice(0, 10));
export function r13Statement() {
  const rows = [
    "发生日期,业务名称,证券代码,证券名称,成交价格,成交数量,成交金额,发生金额,手续费,印花税,过户费,委托编号",
  ];
  let id = 0;
  for (let i = 0; i < 785; i++) {
    const quantities = i < 188 ? [50, 50, 100] : [100, 100];
    for (const q of quantities)
      rows.push(
        `${r13Days[i]},证券买入,600000,合成样本,10,${q},${q * 10},${-q * 10},0,0,0,R13-${id++}`,
      );
    rows.push(
      `${r13Days[i]},证券卖出,600000,合成样本,10,200,2000,2000,0,0,0,R13-${id++}`,
    );
  }
  rows.push(`${r13Days.at(-1)},利息入账,,,0,0,0,0,0,0,0,R13-end`);
  return Buffer.from(rows.join("\n"));
}
