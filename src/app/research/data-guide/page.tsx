import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "~/components/ui/table";
import Link from "next/link";

export default function ResearchDataGuide() {
  return (
    <main className="mx-auto max-w-4xl space-y-5 p-6">
      <h1 className="text-2xl font-semibold">策略研究的数据准备</h1>
      <p>
        先在数据设置中配置通达信目录；研究读取个股日线和上证指数日线，起点之前至少保留61根个股日线。A500、行业和概念名单沿用RPS配置的Blocks目录。源文件只读，首次运行后保存独立快照。
      </p>
      <h2 className="text-xl font-semibold">先看信号，再看交易</h2>
      <p>
        无需交易条件文件即可研究信号出现后的价格表现。事件观察用下一交易日开盘至指定观察日收盘的价格变化，不扣交易费用，也不表示当天能够买卖。交易模拟另按资金、仓位、下一日开盘、持有日数、费用和成交限制计算。两种结果分别展示。
      </p>
      <p>
        “按原快照重跑”保留原参数、股票名单、行情和已导入条件；尚未采集成功的任务重试时会重新采集。若要更改参数或读取更新后的行情，请创建新研究。
      </p>
      <h2 className="text-xl font-semibold">历史交易条件文件</h2>
      <p>
        从可靠历史数据来源导出JSON，上传上限20MiB。每条记录对应一只股票的一个交易日；价格须与未复权日线一致。当前名称、ST状态或当前涨跌停规则不能代替历史状态。程序校验格式并保留来源，但不会把导入声明自动视为已核验。
      </p>
      <Table className="w-full text-left text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>字段</TableHead>
            <TableHead>含义</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[
            ["version", "固定为 research-market-evidence-1"],
            ["source / exportedAt", "数据来源说明 / 导出时间（Unix毫秒）"],
            ["adjustment", "固定为 none，即未复权"],
            [
              "rows[].symbol / date",
              "股票代码如 sh600000 / 日期 YYYY-MM-DD，不可重复",
            ],
            ["rows[].tradable", "当日是否允许交易（true或false）"],
            [
              "rows[].limitUp / limitDown",
              "当日实际涨停价 / 跌停价；null仅表示确实无该限制，不表示未知",
            ],
            [
              "rows[].minimumBuy / buyStep / maximumOrder",
              "最小买入股数 / 申报递增股数 / 单笔最大股数",
            ],
            ["rows[].evidenceId", "能回溯到原始来源记录的证据编号"],
            [
              "corporateActionFree[]",
              "symbol、start、end、evidenceId：覆盖整个研究区间的无公司行动证据。不能仅因本地文件没有记录就填无事件",
            ],
          ].map(([field, description]) => (
            <TableRow key={field}>
              <TableCell className="border-b p-2 font-mono">{field}</TableCell>
              <TableCell className="border-b p-2">{description}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p>
        没有某日交易条件时，该日不模拟成交；缺少完整无公司行动证据或本地已记录区间内除权事件的股票，当前不会进入交易模拟。含分红送转的完整资金与股份结算尚未接入。不要通过填写虚假“无事件”来获得指标。
      </p>
      <h2 className="text-xl font-semibold">如何读结果</h2>
      <p>
        交易胜率只统计已平仓交易，盈亏比是平均盈利与平均亏损绝对值之比。没有亏损样本时显示“—”。未成交、未平仓和缺价单独列出。夏普使用每日净值、年化因子252和设置的无风险利率；净值估价缺失或波动不足时不计算。
      </p>
      <p>
        开发期用于调整参数，保留验证期用于观察未参与调整的样本，两期资金独立。当前成分名单回看历史存在幸存者偏差，小样本结果也可能不稳定。导出文件保存完整明细，页面仅展示部分明细以便浏览。
      </p>
      <Link className="text-primary underline" href="/research">
        返回策略研究
      </Link>
    </main>
  );
}
