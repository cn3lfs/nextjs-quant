import type { revenueReconciliation } from "~/server/revenue-reconciliation";

type Reconciliation = ReturnType<typeof revenueReconciliation>;
const amount = (value: number | null) =>
  value === null
    ? "缺失"
    : (Math.abs(value) < 0.005 ? 0 : value).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const match = (value: boolean | null) =>
  value === null ? "资料不足" : value ? "数值匹配" : "存在差异";

export function RevenueReconciliationPanel({
  data,
}: {
  data?: Reconciliation;
}) {
  return (
    <section aria-label="收入口径核对">
      <h3>收入口径核对</h3>
      {!data ? (
        <p>
          此历史报告未包含收入口径核对。重新生成报告时才会采集并计算，查看历史不会补写原档案。
        </p>
      ) : (
        <>
          <p className="muted">
            {data.period.slice(0, 4)} 年度 · 金额单位：来源元，币种尚未核验。
            以下为后端计算，数值匹配不代表合并范围或审计已核验。
          </p>
          <div style={{ overflowX: "auto" }}>
            <table aria-label="年度收入口径">
              <thead>
                <tr>
                  <th scope="col">口径</th>
                  <th scope="col">金额（来源元）</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["原财务档案营业收入", data.archivedRevenue],
                  ["本次资料营业收入", data.amounts.revenue],
                  ["本次资料营业总收入", data.amounts.totalRevenue],
                  ["本次资料利息收入", data.amounts.interestIncome],
                ].map(([label, value]) => (
                  <tr key={label as string}>
                    <th scope="row">{label as string}</th>
                    <td>{amount(value as number | null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            新旧营业收入：{match(data.archiveRevenueMatches)}
            。原档案收入和增长计算保持不变。
          </p>
          <p>
            营业总收入 − 营业收入：{amount(data.totalMinusRevenue)} 元；
            再扣除利息收入后的残差：{amount(data.residualAfterInterest)} 元。
            差额与利息收入：{match(data.differenceMatchesInterest)}。
          </p>
          {data.groups.length ? (
            <div style={{ overflowX: "auto" }}>
              <table aria-label="主营分类收入核对">
                <thead>
                  <tr>
                    <th scope="col">分类</th>
                    <th scope="col">项目数</th>
                    <th scope="col">收入合计（来源元）</th>
                    <th scope="col">较原档案差额（来源元）</th>
                    <th scope="col">与营业收入比较</th>
                    <th scope="col">与营业总收入比较</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((group) => (
                    <tr key={group.classification}>
                      <th scope="row">{group.classification}</th>
                      <td>{group.rows}</td>
                      <td>{amount(group.revenue)}</td>
                      <td>{amount(group.differenceFromArchivedRevenue)}</td>
                      <td>{match(group.matchesRevenue)}</td>
                      <td>{match(group.matchesTotalRevenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>缺少主营分类资料，无法核对分类合计。</p>
          )}
          <p className="muted">
            行业、产品、地区分别合计，不能跨分类相加。金额展示保留两位小数，完整精度及匹配容差见明细。
          </p>
          {data.missing.length > 0 && (
            <div>
              <strong>缺项与待核验差异</strong>
              <ul>
                {data.missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <details>
            <summary>收入口径公式、限制与证据引用</summary>
            <ul>
              {data.warnings.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
