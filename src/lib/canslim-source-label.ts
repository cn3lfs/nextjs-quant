const labels: Record<string, string> = {
  "sector-rank": "行业与成分股排名",
  finance: "财务资料",
  "quarter-eps": "季度每股收益",
  "annual-eps": "年度每股收益与现金流",
  growth: "营收与利润增长",
  market: "市场指数",
  institutions: "机构持仓",
  "relative-strength": "相对强弱价格池",
  "rs-membership": "独立证券名单审计",
  float: "流通市值",
};
export function canslimSourceLabel(id: string) {
  return labels[id] ?? id;
}
