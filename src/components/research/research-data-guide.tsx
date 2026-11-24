import Link from "next/link";
import { ReadingLayout } from "../common/reading-layout";

export default function ResearchDataGuide() {
  return (
    <article className="min-w-0 space-y-5">
      <h1 className="text-2xl font-semibold">策略研究的数据准备</h1>
      <ReadingLayout>
        <p>
          按研究入口准备对应数据。规则已实现、数据可用和历史结果可信是三个不同判断；
          任务能运行不代表结果已具备可信策略业绩所需的证据。
        </p>
        <h2 className="text-xl font-semibold">选择研究入口</h2>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Link className="text-primary underline" href="/lab">
              策略中心
            </Link>
            ：查看规则、输入要求与预热长度，运行已开放的日线实验或组合研究。
            目标权重计算与历史组合撮合是不同操作；只有权重结果时，不能当作历史收益。
            目录中的研究登记和缺数据项目不等于可执行策略。
          </li>
          <li>
            <Link className="text-primary underline" href="/lab/backtest">
              策略实验
            </Link>
            ：使用本地五分钟行情配置双均线基线或因子条件，检查覆盖后创建任务，
            查看报告、订单诊断、历史记录和导出。
          </li>
          <li>
            <Link
              className="text-primary underline"
              href="/lab/analysis?tab=evidence"
            >
              证据分析
            </Link>
            ：基于已加载行情提出研究问题，配置相应模型后主动生成通用研究报告。
            报告在
            <Link className="text-primary underline" href="/lab/reports">
              研究档案
            </Link>
            检索； 报告观点不作为自动交易指令。
          </li>
        </ul>
        <h2 className="text-xl font-semibold">准备本地数据</h2>
        <p>
          在
          <Link className="text-primary underline" href="/system">
            数据与连接
          </Link>
          保存通达信目录，并扫描本地证券。日线实验需要个股日线和上证指数日线；
          五分钟实验还需要对应证券的完整五分钟行情。图表可以显示行情，
          不代表所选研究区间、预热和交易日历已满足实验要求。
        </p>
        <p>
          公司行动来源必须可读取。日线实验支持已核验输入中的现金分红，
          遇到当前不支持的非现金公司行动会拒绝运行；五分钟基线在研究窗口或预热内
          存在已知除权、股本调整事件时拒绝运行。缺少来源不能当作“没有事件”。
        </p>
        <p>
          使用财务、横截面或组合规则时，按策略列出的输入要求准备本地财报、序列和证券池。
          财报必须在决策时点已经可知，当前财报或当前成分名单不能自动替代历史输入。
          缺失项按任务结果披露，不填零、不补造。通达信和外部 Blocks 源目录只读。
        </p>
        <h2 className="text-xl font-semibold">日期、预热与缺失</h2>
        <p>
          策略中心默认结束日期取本地上证指数日历中上海今天之前的最近日期，
          默认开始日期向前 365
          天。默认日期仅说明本地日历范围，不证明个股覆盖完整；
          没有可用日历时手工填写日期，读取恢复不会覆盖已填写的值。
        </p>
        <p>
          日线实验只接受已结束的历史日期。所需预热以所选策略为准，
          不使用统一的固定根数；股票与日历不一致、区间超出覆盖或源行情含修复、丢弃时，
          任务会给出原因并拒绝运行。五分钟实验还会检查完整交易时段和连续预热，
          不靠补造行情或静默顺延绕过缺口。
        </p>
        <p>
          当前日线实验支持沪深 100 股整手股票；原生缠论日线任务最多 366 自然日。
          组合研究的证券数量和日期范围以表单及服务校验为准。
          输入校验通过后仍需读取真实数据，后续缺失或解析失败会显示为任务失败，不能当作零收益。
        </p>
        <h2 className="text-xl font-semibold">结果与证据边界</h2>
        <p>
          日线实验按收盘决策、下一交易日开盘撮合；五分钟实验最早在下一根开盘执行。
          费用、交易限制和公司行动处理按各实验的冻结配置与结果读取，不能在不同实验间套用。
          未成交订单、未平仓持仓和缺失估值应单独查看，不能视为已完成交易。
        </p>
        <p>
          查看结果时同时核对证券池、日期、周期、复权、来源、规则和引擎版本。
          报告生成时间与证据数据时点分别显示；保存结果与导出用于复核输入和计算，
          不会自动消除幸存者偏差、历史可知性或成交条件不足。当前规则自检结果不能称为可信策略业绩。
        </p>
        <p>
          旧样本研究及其交易条件文件上传、原快照重跑入口已退役。
          新实验从上述现行入口创建；信号监控、信号台账和盘中预选调度仍暂停，
          完成研究不会恢复调度、补发通知或自动下单。
        </p>
      </ReadingLayout>
    </article>
  );
}
