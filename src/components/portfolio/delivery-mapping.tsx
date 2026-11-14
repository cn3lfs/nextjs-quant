import type {
  ColumnMapping,
  DeliveryField,
} from "~/lib/research/evidence/delivery-import";
import { Button } from "../ui/button";
export const deliveryFieldLabels: Record<DeliveryField, string> = {
  tradeDate: "成交日期",
  tradeTime: "成交时间",
  code: "证券代码",
  name: "证券名称",
  summary: "业务摘要",
  side: "买卖方向",
  price: "成交价格",
  quantity: "成交数量",
  amount: "成交金额",
  netAmount: "资金发生额",
  commission: "佣金",
  stampTax: "印花税",
  transferFee: "过户费",
  otherFee: "其它费用",
  feeTotal: "费用合计",
  balanceShares: "证券余额",
  balanceCash: "资金余额",
  orderId: "委托编号",
  dealId: "成交编号",
  businessFlag: "业务标记",
  currency: "币种",
  note: "备注",
  account: "资金账号（脱敏）",
};
export function DeliveryMapping({
  mapping,
  sourceHeader,
  diagnostics = [],
}: {
  mapping: ColumnMapping;
  sourceHeader?: string[] | null;
  diagnostics?: string[];
}) {
  const column = (index: number) =>
    `第 ${index + 1} 列${sourceHeader?.[index] ? `「${sourceHeader[index]}」` : "（历史未记录原列名）"}`;
  return (
    <section aria-label="列映射结果" className="space-y-2 break-words text-sm">
      <h3 className="font-medium">列映射结果</h3>
      <dl className="grid gap-2 sm:grid-cols-2">
        {Object.entries(mapping.columns).map(([field, index]) => (
          <div key={field}>
            <dt className="text-muted-foreground">{column(index!)}</dt>
            <dd>{deliveryFieldLabels[field as DeliveryField]}</dd>
          </div>
        ))}
      </dl>
      <p>
        费用参与列：
        {Object.entries(mapping.feeColumns)
          .map(
            ([field, indices]) =>
              `${deliveryFieldLabels[field as DeliveryField]}：${indices.map(column).join("、") || "未提供"}`,
          )
          .join("；")}
      </p>
      <p>
        未映射的列：
        {mapping.unmapped
          .map((value) => `第 ${value.index + 1} 列「${value.header}」`)
          .join("；") || "无"}
      </p>
      <p>
        重复列：
        {mapping.duplicates
          .map(
            (value) =>
              `第 ${value.index + 1} 列「${value.header}」 → ${deliveryFieldLabels[value.field]}`,
          )
          .join("；") || "无"}
      </p>
      {[...new Set([...mapping.warnings, ...diagnostics])].map(
        (message, index) => (
          <p key={index}>{message}</p>
        ),
      )}
      <p>缺失费用或余额保持未知，不按零处理。</p>
    </section>
  );
}
export function DeliveryConfirm({
  account,
  conflicts,
  busy,
  onConfirm,
}: {
  account: string;
  conflicts: number;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-2">
      {conflicts > 0 && (
        <p role="alert">存在冲突，禁止导入；请核对差异并重新预览。</p>
      )}
      <Button disabled={conflicts > 0 || busy} onClick={onConfirm}>
        确认导入到 {account}
      </Button>
    </div>
  );
}
