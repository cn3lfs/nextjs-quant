"use client";

import { Button } from "~/components/ui/button";
import { DataTable } from "~/components/ui/data-table";

import { Input } from "~/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";

import { useRef, useState, useTransition } from "react";
import {
  Briefcase,
  ChartScatter,
  FloppyDisk,
  NotePencil,
  Receipt,
  Robot,
  Scales,
  UploadSimple,
  Wallet,
} from "@phosphor-icons/react/ssr";
import Link from "next/link";
import {
  changeTone,
  GridTable,
  PageGrid,
  Panel,
  PanelEmpty,
  StatsPanel,
  toneText,
  type Stat,
} from "../panels";
import { feeLabel } from "~/lib/trade-ledger";
import { mockContract, mockMarketLabel } from "~/lib/mock-trading-contract";
import type { tradeDashboard } from "~/server/portfolio/trade-ledger-service";
import type {
  reconcileMock,
  previewMockOrder,
} from "~/server/portfolio/mock/mock-trading-service";
import {
  readMockDiagnostics,
  readMockMarkets,
  readMockFunds,
  readMockTrades,
  recoverMockAccount,
  saveTrade,
  toggleMock,
  createMockAccount,
  reconcileAccount,
  previewOrder,
  confirmOrder,
  updateStop,
  saveBonusListing,
} from "~/app/trade-ledger/actions";
type Dashboard = Awaited<ReturnType<typeof tradeDashboard>>;
const number = (n: number | null | undefined) =>
  n == null ? "—" : n.toFixed(2);
export function TradeLedgerPanel({
  data,
  enabled,
}: {
  data: Dashboard;
  enabled: boolean;
}) {
  const [pending, start] = useTransition(),
    [message, setMessage] = useState("");
  const [diff, setDiff] = useState<Awaited<
    ReturnType<typeof reconcileMock>
  > | null>(null);
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof previewMockOrder>
  > | null>(null);
  const [diagnostics, setDiagnostics] = useState<Awaited<
    ReturnType<typeof readMockDiagnostics>
  > | null>(null);
  const [markets, setMarkets] = useState<string[]>([]);
  const [remoteQuery, setRemoteQuery] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null),
    tradeId = useRef<string | null>(null);
  const run = (work: () => Promise<void>) =>
    start(async () => {
      setMessage("");
      try {
        await work();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "操作失败，请重试");
      }
    });
  function input() {
    if (!form.current?.reportValidity())
      throw new Error("请填写完整有效的交易信息");
    const f = new FormData(form.current);
    tradeId.current ??= crypto.randomUUID();
    return {
      id: tradeId.current,
      symbol: String(f.get("symbol")).trim(),
      date: String(f.get("date")),
      side: String(f.get("side")),
      price: Number(f.get("price")),
      quantity: Number(f.get("quantity")),
      lowerLimit: Number(f.get("lowerLimit")),
      upperLimit: Number(f.get("upperLimit")),
      limitSource: String(f.get("limitSource")),
      signalId: String(f.get("signalId")) || null,
      stop: f.get("stop") ? Number(f.get("stop")) : null,
      note: String(f.get("note")),
    };
  }
  return (
    <PageGrid>
      <StatsPanel
        icon={Wallet}
        title="账户"
        meta="本地账本为事实来源。人工录入、离线计算；模拟盘默认关闭。"
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/trade-review" scroll={false}>
              <UploadSimple size={13} />
              交割单与交易复盘
            </Link>
          </Button>
        }
        items={tradeStats(data, enabled)}
      />
      <p
        role="status"
        aria-live="polite"
        className="nc-span-12 m-0 text-[12px] text-nc-text-3 empty:hidden"
      >
        {pending ? "正在处理…" : message}
      </p>
      {/* Source order keeps the original handler order; `order-*` sets the
          on-screen order: 持仓 → 交易日志 → 录入 → 除权 → 对比 → 模拟盘. */}
      <Panel
        className="order-3"
        icon={NotePencil}
        title="录入本地交易"
        note={`${feeLabel}：cost-experiment-1，佣金3bp / 最低5元、卖出印花税5bp、滑点5bp。成交价保留，滑点作为实验成本另计。`}
      >
        <form
          ref={form}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await saveTrade(input());
              tradeId.current = null;
              setMessage("交易已记入本地账本，未向外部下单");
            });
          }}
        >
          <fieldset disabled={pending} className="m-0 border-0 p-0">
            <div className="form-grid">
              <label>
                股票代码（如sh600519）
                <Input name="symbol" required pattern="(sh|sz|bj)[0-9]{6}" />
              </label>
              <label>
                成交日期
                <Input
                  name="date"
                  type="date"
                  required
                  defaultValue={data.today}
                  max={data.today}
                />
              </label>
              <label>
                买卖
                <Select name="side" defaultValue="buy">
                  <SelectTrigger aria-label="买卖" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buy">买入</SelectItem>
                    <SelectItem value="sell">卖出</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label>
                成交价格
                <Input
                  name="price"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                />
              </label>
              <label>
                数量（100股整数倍）
                <Input
                  name="quantity"
                  type="number"
                  step="100"
                  min="100"
                  required
                />
              </label>
              <label>
                当日跌停价
                <Input
                  name="lowerLimit"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                />
              </label>
              <label>
                当日涨停价
                <Input
                  name="upperLimit"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                />
              </label>
              <label>
                涨跌停依据（终端及日期）
                <Input name="limitSource" required maxLength={200} />
              </label>
              <label>
                关联台账信号（可空）
                <Select name="signalId" defaultValue="">
                  <SelectTrigger
                    aria-label="关联台账信号（可空）"
                    className="w-full"
                  >
                    <SelectValue placeholder="手动交易，不关联" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">手动交易，不关联</SelectItem>
                    {data.signals.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.date} · {s.symbol} · {s.strategy} ·{" "}
                        {s.id.slice(0, 8)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label>
                止损位（可空，可在持仓中更新）
                <Input name="stop" type="number" min="0.01" step="0.01" />
              </label>
              <label>
                备注
                <Input name="note" maxLength={500} />
              </label>
            </div>
            <p className="muted">
              涨跌停上下限按该交易日终端值录入；无普通涨跌幅限制或依据未知时暂不录入，避免套用常规比例。记录只追加，保存后可查原值。
            </p>
            <Button type="submit">
              <FloppyDisk size={14} />
              仅保存本地交易
            </Button>
          </fieldset>
        </form>
      </Panel>
      <Panel
        className="order-1"
        icon={Briefcase}
        title="当前持仓"
        meta={`日历：${data.calendarSource}`}
        note="本地不复权已完成日线收盘价；日期见各行，非实时行情。止损距离＝（现价－止损位）/现价，负数表示已跌破，不自动卖出。"
      >
        {!data.positions.length && (
          <PanelEmpty>暂无持仓，请先录入一笔买入。</PanelEmpty>
        )}
        <div style={{ overflowX: "auto" }}>
          <DataTable
            label="当前持仓"
            data={data.positions}
            columns={[
              {
                id: "column-0",
                header: "标的",
                enableSorting: false,
                cell: ({ row }) => {
                  const p = row.original;
                  return <strong>{p.symbol}</strong>;
                },
              },
              {
                id: "column-1",
                header: "持股",
                enableSorting: false,
                cell: ({ row }) => {
                  const p = row.original;
                  return <>{p.quantity}</>;
                },
              },
              {
                id: "column-2",
                header: "T+1可卖",
                enableSorting: false,
                cell: ({ row }) => {
                  const p = row.original;
                  return <>{p.sellable}</>;
                },
              },
              {
                id: "column-3",
                header: "核对后成本",
                enableSorting: false,
                cell: ({ row }) => {
                  const p = row.original;
                  return <>{number(p.adjustedCost)}</>;
                },
              },
              {
                id: "column-4",
                header: "参考成本",
                enableSorting: false,
                cell: ({ row }) => {
                  const p = row.original;
                  return <>{number(p.averageCost)}</>;
                },
              },
              {
                id: "column-5",
                header: "本地收盘/日期",
                enableSorting: false,
                cell: ({ row }) => {
                  const p = row.original;
                  return (
                    <>
                      {number(p.quote?.price)} / {p.quote?.date ?? "行情缺失"}
                    </>
                  );
                },
              },
              {
                id: "column-6",
                header: "浮动盈亏",
                enableSorting: false,
                cell: ({ row }) => {
                  const p = row.original;
                  return (
                    <span className={toneText[changeTone(p.floating)]}>
                      {number(p.floating)}
                    </span>
                  );
                },
              },
              {
                id: "column-7",
                header: "止损距离",
                enableSorting: false,
                cell: ({ row }) => {
                  const p = row.original;
                  return (
                    <span
                      className={
                        p.stopDistancePct != null && p.stopDistancePct < 0
                          ? "nc-text-warn"
                          : undefined
                      }
                    >
                      {number(p.stopDistancePct)}%
                    </span>
                  );
                },
              },
              {
                id: "column-8",
                header: "除权状态",
                enableSorting: false,
                cell: ({ row }) => {
                  const p = row.original;
                  return <>{p.adjustmentStatus}</>;
                },
              },
            ]}
            getRowId={(p) => String(p.symbol)}
            rowCount={data.positions.length}
            pagination={{
              pageIndex: 0,
              pageSize: Math.max(1, data.positions.length),
            }}
            sorting={[]}
            onPaginationChange={() => {}}
            onSortingChange={() => {}}
            showPagination={false}
            emptyMessage={null}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          {data.positions
            .filter((p) => p.quantity > 0)
            .map((p) => (
              <form
                key={p.symbol}
                className="flex items-end gap-2 rounded-lg border border-nc-border-soft bg-nc-inset p-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  run(async () => {
                    await updateStop(p.symbol, Number(f.get("stop")));
                    setMessage("止损位已更新，仅本地记录");
                  });
                }}
              >
                <label className="flex flex-col gap-1 text-[11px] text-nc-text-3">
                  {p.symbol} 当前止损位
                  <Input
                    name="stop"
                    type="number"
                    step="0.01"
                    min="0.01"
                    defaultValue={p.stop ?? ""}
                    required
                  />
                </label>
                <Button size="sm" variant="outline" disabled={pending}>
                  更新止损位
                </Button>
              </form>
            ))}
        </div>
      </Panel>
      <Panel
        className="order-4"
        icon={Scales}
        title="除权调整依据"
        meta="保留每次观察版本"
        note="GBBQ不可用时：成本未按除权调整，浮盈留空。配股/缩股依据不足时留空；送转股到账日期未知时暂不计可卖，可按账户显示补录可卖日期。除权后尚无新收盘行情时浮盈留空。参考成本不可当作已核对成本。"
      >
        {!data.adjustments.length && (
          <PanelEmpty>暂无持仓期除权调整记录。</PanelEmpty>
        )}
        {data.adjustments.map((a) => (
          <details key={a.id} className="list-row my-0 block">
            <summary>
              {a.symbol} · {a.event.date} · {a.event.name} · 成本{" "}
              {number(a.beforeCost)} → {number(a.afterCost)}
            </summary>
            <p>
              股数 {a.beforeQuantity} → {a.afterQuantity}；{a.basis}
            </p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(a.event, null, 2)}
              {"\n"}
              {a.source}
            </pre>
            {(a.event.bonusRatio ?? 0) > 0 && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  run(async () => {
                    await saveBonusListing(
                      a.symbol,
                      a.event.date,
                      String(f.get("date")),
                      String(f.get("source")),
                    );
                    setMessage("送转股可卖依据已记录，不修改原交易");
                  });
                }}
              >
                <label className="flex flex-col gap-1 text-[11px] text-nc-text-3">
                  账户确认的送转股可卖日期
                  <Input
                    type="date"
                    name="date"
                    min={a.event.date}
                    max={data.today}
                    required
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-nc-text-3">
                  到账依据
                  <Input name="source" maxLength={200} required />
                </label>
                <Button size="sm" variant="outline" disabled={pending}>
                  保存可卖依据（只记录一次）
                </Button>
              </form>
            )}
          </details>
        ))}
      </Panel>
      <Panel
        className="order-2"
        icon={Receipt}
        title="交易日志"
        meta={`${data.trades.length} 笔 · 只追加`}
      >
        <GridTable
          label="交易日志"
          minWidth={760}
          rows={data.trades}
          rowKey={(t) => t.id}
          empty="暂无交易。"
          columns={[
            {
              key: "date",
              header: "日期",
              width: "0.8fr",
              cell: (t) => <span className="text-nc-text-3">{t.date}</span>,
            },
            {
              key: "symbol",
              header: "证券",
              width: "0.9fr",
              cell: (t) => <strong className="font-medium">{t.symbol}</strong>,
            },
            {
              key: "side",
              header: "方向",
              width: "0.5fr",
              cell: (t) => (
                <span className={t.side === "buy" ? "up" : "down"}>
                  {t.side === "buy" ? "买入" : "卖出"}
                </span>
              ),
            },
            {
              key: "price",
              header: "价格",
              width: "0.7fr",
              cell: (t) => <>{t.price}</>,
            },
            {
              key: "quantity",
              header: "股数",
              width: "0.6fr",
              cell: (t) => <>{t.quantity}</>,
            },
            {
              key: "fees",
              header: "实验费用",
              width: "0.7fr",
              cell: (t) => (
                <span
                  className="text-nc-text-3"
                  title={`佣金 ${number(t.fees.commission)} / 税 ${number(t.fees.tax)} / 滑点 ${number(t.fees.slippage)}；${feeLabel}`}
                >
                  {number(t.fees.total)}
                </span>
              ),
            },
            {
              key: "signal",
              header: "关联信号",
              width: "1.6fr",
              cell: (t) => (
                <details className="my-0">
                  <summary
                    className={t.signalId ? undefined : "text-nc-text-4"}
                  >
                    {t.signalId ? t.signalId.slice(0, 12) : "无（手动交易）"}
                  </summary>
                  <p>{t.note}</p>
                  <p>
                    涨跌停 {t.lowerLimit}–{t.upperLimit}；依据：{t.limitSource}
                  </p>
                  <pre
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {JSON.stringify(t.methods, null, 2)}
                  </pre>
                </details>
              ),
            },
          ]}
        />
      </Panel>
      <Panel
        className="order-5"
        icon={ChartScatter}
        title="做过与没做的信号"
        note="按是否关联任一交易分组，比较同口径 N1 向前收益，非实际交易盈亏、非策略业绩，不代表跟随信号的因果效果。含除权/未到期沿用台账留空规则。"
      >
        {!data.comparison.length && (
          <PanelEmpty>暂无可比较台账信号。</PanelEmpty>
        )}
        <div style={{ overflowX: "auto" }}>
          <DataTable
            label="做过与没做的信号"
            data={data.comparison}
            columns={[
              {
                id: "column-0",
                header: "分组",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{c.group}</>;
                },
              },
              {
                id: "column-1",
                header: "策略/质量",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return (
                    <>
                      {c.strategy} / {c.quality}
                    </>
                  );
                },
              },
              {
                id: "column-2",
                header: "期限",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>T+{c.horizon}</>;
                },
              },
              {
                id: "column-3",
                header: "样本/有效",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return (
                    <>
                      {c.samples}/{c.valid}
                    </>
                  );
                },
              },
              {
                id: "column-4",
                header: "中位收益%",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{number(c.median)}</>;
                },
              },
              {
                id: "column-5",
                header: "胜率%",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{number(c.winRate)}</>;
                },
              },
              {
                id: "column-6",
                header: "留空",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{c.blanks}</>;
                },
              },
            ]}
            getRowId={(c) =>
              String(`${c.group}-${c.strategy}-${c.quality}-${c.horizon}`)
            }
            rowCount={data.comparison.length}
            pagination={{
              pageIndex: 0,
              pageSize: Math.max(1, data.comparison.length),
            }}
            sorting={[]}
            onPaginationChange={() => {}}
            onSortingChange={() => {}}
            showPagination={false}
            emptyMessage={null}
          />
        </div>
      </Panel>
      <Panel
        className="order-6"
        icon={Robot}
        title="同花顺模拟盘（可选同步层）"
        tag={enabled ? "已开启" : "已关闭"}
        note="同花顺问财提供模拟炒股服务"
      >
        <details>
          <summary>文档契约与实测契约差异</summary>
          <DataTable
            label="文档契约与实测契约差异"
            data={[...mockContract]}
            columns={[
              {
                id: "column-0",
                header: "文档契约",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{c.documented}</>;
                },
              },
              {
                id: "column-1",
                header: "实测契约",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{c.observed}</>;
                },
              },
              {
                id: "column-2",
                header: "差异与处理",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{c.difference}</>;
                },
              },
            ]}
            getRowId={(c) => String(c.documented)}
            rowCount={mockContract.length}
            pagination={{
              pageIndex: 0,
              pageSize: Math.max(1, mockContract.length),
            }}
            sorting={[]}
            onPaginationChange={() => {}}
            onSortingChange={() => {}}
            showPagination={false}
            emptyMessage={null}
          />
        </details>
        <div className="button-row">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !enabled}
            onClick={() => run(async () => setMarkets(await readMockMarkets()))}
          >
            查看已保存市场代码（本地）
          </Button>
          {markets.map((code) => (
            <p key={code}>
              {code}：{mockMarketLabel(code)}
            </p>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !enabled}
            onClick={() =>
              run(async () => setRemoteQuery(await readMockFunds()))
            }
          >
            查询远程资金
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !enabled}
            onClick={() =>
              run(async () => setRemoteQuery(await readMockTrades()))
            }
          >
            查询当日成交
          </Button>
        </div>
        {remoteQuery !== null && (
          <pre className="overflow-auto">
            {JSON.stringify(remoteQuery, null, 2)}
          </pre>
        )}
        <p className="muted">
          当前{enabled ? "已开启" : "关闭"}
          。关闭时不读取远程账户、不发送任何远程请求。开启本身也不开户；所有远程操作需点击。
        </p>
        <div className="button-row">
          <Button
            size="sm"
            variant={enabled ? "danger" : "default"}
            disabled={pending}
            onClick={() =>
              run(async () => {
                await toggleMock(!enabled);
                setDiff(null);
                setPreview(null);
                setMessage(
                  enabled ? "模拟盘已关闭" : "模拟盘已开启，尚未开户或下单",
                );
              })
            }
          >
            {enabled ? "关闭模拟盘" : "开启模拟盘"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(async () => {
                setDiagnostics(await readMockDiagnostics());
              })
            }
          >
            查看最近20次脱敏响应（本地）
          </Button>
        </div>
        {diagnostics && (
          <div aria-live="polite">
            {diagnostics.length === 0
              ? "尚无响应记录"
              : diagnostics.map((entry, i) => (
                  <details key={i}>
                    <summary>
                      {entry.path} ·{" "}
                      {new Date(entry.envelope.fetchedAt).toLocaleString()} ·
                      HTTP {entry.httpStatus ?? "未收到"}
                    </summary>
                    <pre className="overflow-auto">
                      {JSON.stringify(entry, null, 2)}
                    </pre>
                  </details>
                ))}
          </div>
        )}
        {enabled && (
          <>
            <p className="notice">
              开户将在第三方建立持久账户，用户名以DPAPI加密保存。服务使用HTTP。委托与本地交易互不自动覆盖。
            </p>
            <div className="button-row">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await createMockAccount();
                    setMessage("账户已准备，可手动对账");
                  })
                }
              >
                确认创建或使用模拟账户
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await recoverMockAccount();
                    setMessage("既有账户股东账号已核验");
                  })
                }
              >
                查询既有账户股东账号（不开户）
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    setDiff(await reconcileAccount());
                    setMessage("对账完成，未覆盖任何一侧");
                  })
                }
              >
                查询远程并对账
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    setPreview(await previewOrder(input()));
                    setMessage("请核对委托后点击确认；预览60秒过期");
                  })
                }
              >
                用上方输入预览模拟委托
              </Button>
            </div>
            {preview && (
              <div
                role="group"
                aria-label="确认模拟委托"
                className="notice mt-3"
              >
                <p>
                  {preview.input.symbol} ·{" "}
                  {preview.input.side === "buy" ? "买入" : "卖出"} ·{" "}
                  {preview.input.quantity}股 × {preview.input.price}
                  元；确认后发送远程委托。
                </p>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const id = preview.id;
                      setPreview(null);
                      setMessage(await confirmOrder(id));
                    })
                  }
                >
                  确认发送这笔模拟委托
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPreview(null)}
                >
                  取消
                </Button>
              </div>
            )}
            {diff && (
              <>
                <h3>对账差异（本地减远程）</h3>
                <p>两侧成本参数可能不同，差异不会触发同步覆盖。</p>
                {!diff.length && <p>两侧均无持仓。</p>}
                {diff.map((d) => (
                  <p key={d.symbol}>
                    {d.symbol}：持股 本地{d.localQuantity} / 远程
                    {d.remoteQuantity} / 差{d.quantityDifference}；可卖 本地
                    {d.localSellable} / 远程{d.remoteSellable}；成本 本地
                    {number(d.localCost)} / 远程{number(d.remoteCost)} / 差
                    {number(d.costDifference)}
                  </p>
                ))}
              </>
            )}
          </>
        )}
      </Panel>
    </PageGrid>
  );
}

/** Header counts derived from the dashboard rows; nothing is fetched here. */
const tradeStats = (data: Dashboard, enabled: boolean): Stat[] => {
  const held = data.positions.filter((p) => p.quantity > 0);
  const priced = held.filter((p) => p.quote?.price != null);
  const value = priced.reduce((s, p) => s + p.quantity * p.quote!.price, 0);
  const floating = held.filter((p) => p.floating != null);
  const total = floating.reduce((s, p) => s + p.floating!, 0);
  const breached = held.filter(
    (p) => p.stopDistancePct != null && p.stopDistancePct < 0,
  ).length;
  return [
    {
      label: "持仓",
      value: `${held.length} 只`,
      note: `T+1 可卖 ${held.filter((p) => p.sellable > 0).length} 只`,
    },
    {
      label: "持仓市值",
      value: priced.length ? number(value) : "—",
      note:
        priced.length < held.length
          ? `${held.length - priced.length} 只缺本地收盘`
          : "本地收盘价计",
    },
    {
      label: "浮动盈亏",
      value: floating.length ? number(total) : "—",
      note:
        floating.length < held.length
          ? `${held.length - floating.length} 只留空（除权或缺价）`
          : "不含已实现",
      tone: floating.length ? changeTone(total) : "neutral",
    },
    {
      label: "跌破止损",
      value: breached,
      note: "不自动卖出",
      tone: breached ? "warn" : "neutral",
    },
    {
      label: "交易记录",
      value: data.trades.length,
      note: `${data.trades.filter((t) => t.signalId).length} 笔关联信号`,
    },
    {
      label: "模拟盘",
      value: enabled ? "已开启" : "已关闭",
      note: "关闭时不发远程请求",
      tone: enabled ? "accent" : "idle",
    },
  ];
};
