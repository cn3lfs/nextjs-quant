export type InstitutionPoint = {
  period: string;
  shares: number | null;
  ratio: number | null;
  count: number | null;
};
export function scoreCanslimInstitutions(series: InstitutionPoint[]) {
  const quarter = (period: string) =>
    Number(period.slice(0, 4)) * 4 + Number(period.slice(4, 6)) / 3;
  const complete =
    series.length === 3 &&
    series.every(
      (p, i) =>
        p.shares !== null &&
        p.ratio !== null &&
        p.count !== null &&
        (!i || quarter(series[i - 1]!.period) - quarter(p.period) === 1),
    );
  const latest = series[0],
    prior = series[1],
    oldest = series[2];
  const zeroBase = complete && (prior!.shares === 0 || oldest!.shares === 0);
  const turnover =
    complete &&
    latest!.count! > prior!.count! &&
    latest!.ratio! < prior!.ratio!;
  const increasing = complete && latest!.shares! > prior!.shares!;
  const twice = increasing && prior!.shares! > oldest!.shares!;
  const strong =
    twice &&
    latest!.shares! > prior!.shares! * 1.1 &&
    prior!.shares! > oldest!.shares! * 1.1;
  const status = !complete ? "missing" : zeroBase ? "conflict" : "computed";
  return {
    id: "I1",
    maxPoints: 5,
    version: "canslim-institutions-1",
    status,
    points:
      status !== "computed"
        ? 0
        : turnover
          ? 2
          : strong
            ? 5
            : twice
              ? 4
              : increasing
                ? 2
                : 0,
    series,
    turnover,
    warnings: [
      "主体评分采用机构持股股数，不以机构家数替代；机构家数增加且占流通股比例下降时按例外给2分。",
      "连续两季增加需要三个连续季度；两次环比均严格超过10%才给5分，这是应用明确口径。缺期保留missing，零基数不伪算增幅。",
      "机构统计范围、季末披露时点与股本可比性尚未独立核验，computed仅为计算诊断。",
    ],
  };
}
