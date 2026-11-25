"use client";

import { useEffect, useState } from "react";
import { chinaDate } from "~/lib/market/security-trading-status";
import { tradeInputSchema } from "~/lib/portfolio/trade-ledger";
import { api, type RouterOutputs } from "~/trpc/react";
import { ChartSymbolLink } from "../market/chart-symbol-link";
import { useSecurityNames } from "../market/use-security-names";
import {
  FormField,
  FormGrid,
  GridTable,
  Panel,
  Segmented,
  StatCards,
  StateBanner,
} from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { tradeNumber } from "./trade-workspace-fields";

type Overview = RouterOutputs["thsMockOverview"];
type SecurityNames = ReturnType<typeof useSecurityNames>["data"];
type MockOrderStatus = RouterOutputs["thsMockOrderStatus"];
type Preview = RouterOutputs["thsMockPreviewOrder"] & { expiresAt: number };
const previewLifetime = 60_000;
const manualRequest = { retry: false, networkMode: "always" } as const;
function MockPositionsTable({
  positions,
  names,
}: {
  positions: Overview["positions"];
  names: SecurityNames;
}) {
  return (
    <GridTable
      label="同花顺模拟持仓"
      rows={positions}
      rowKey={(row, index) => `${row.symbol}:${index}`}
      minWidth={420}
      empty="暂无持仓"
      columns={[
        {
          key: "symbol",
          header: "标的",
          width: "1.8fr",
          cell: (row) => (
            <ChartSymbolLink symbol={row.symbol} name={names?.[row.symbol]} />
          ),
        },
        {
          key: "quantity",
          header: "持仓股数",
          align: "right",
          cell: (row) => tradeNumber(row.quantity),
        },
        {
          key: "sellable",
          header: "可卖股数",
          align: "right",
          cell: (row) => tradeNumber(row.sellable),
        },
        {
          key: "cost",
          header: "成本价（元）",
          align: "right",
          cell: (row) =>
            row.cost.toLocaleString("zh-CN", { maximumFractionDigits: 4 }),
        },
      ]}
    />
  );
}

function MockTradesTable({
  trades,
  names,
  label,
}: {
  trades: Overview["trades"];
  names: SecurityNames;
  label: string;
}) {
  return (
    <GridTable
      label={label}
      rows={trades}
      rowKey={(row, index) =>
        `${row.tradeNo ?? row.entrustNo ?? row.cjsj}:${index}`
      }
      minWidth={760}
      empty="暂无成交"
      columns={[
        { key: "time", header: "成交时间", cell: (row) => row.cjsj },
        {
          key: "symbol",
          header: "标的",
          width: "1.7fr",
          cell: ({ zqdm }) => {
            const market = zqdm.startsWith("6")
              ? "sh"
              : /^[03]/.test(zqdm)
                ? "sz"
                : "bj";
            const symbol = `${market}${zqdm}`;
            return <ChartSymbolLink symbol={symbol} name={names?.[symbol]} />;
          },
        },
        {
          key: "side",
          header: "方向",
          cell: ({ mmlb }) =>
            mmlb === "B" ? "买入" : mmlb === "S" ? "卖出" : mmlb,
        },
        {
          key: "price",
          header: "成交价（元）",
          align: "right",
          cell: (row) => tradeNumber(row.cjg),
        },
        {
          key: "quantity",
          header: "成交股数",
          align: "right",
          cell: (row) => tradeNumber(row.cjsl),
        },
        {
          key: "amount",
          header: "成交额（元）",
          align: "right",
          cell: (row) => tradeNumber(row.cje),
        },
        {
          key: "entrustNo",
          header: "委托号",
          width: "1.4fr",
          cell: (row) => (
            <span className="break-all">{row.entrustNo ?? "—"}</span>
          ),
        },
      ]}
    />
  );
}

function useMockOrders() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [expired, setExpired] = useState(false);
  const [lastOrderId, setLastOrderId] = useState<string | null>(null);
  const [validation, setValidation] = useState("");
  const prepare = api.thsMockPreviewOrder.useMutation(manualRequest);
  const confirm = api.thsMockConfirmOrder.useMutation(manualRequest);
  const status = api.thsMockOrderStatus.useMutation(manualRequest);
  const busy = prepare.isPending || confirm.isPending || status.isPending;

  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, preview.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [preview]);

  function prepareOrder(form: FormData) {
    if (busy || preview) return;
    const symbol = String(form.get("symbol") ?? "")
      .trim()
      .toLowerCase();
    if (!/^(sh(60|68)|sz(00|30))\d{4}$/.test(symbol)) {
      setValidation("请输入沪深股票代码，例如 sh600519 或 sz000001。");
      return;
    }
    const startedAt = Date.now();
    const result = tradeInputSchema.safeParse({
      id: crypto.randomUUID(),
      symbol,
      date: chinaDate(startedAt),
      side: form.get("side"),
      price: Number(form.get("price")),
      quantity: Number(form.get("quantity")),
      lowerLimit: Number(form.get("lowerLimit")),
      upperLimit: Number(form.get("upperLimit")),
      limitSource: form.get("limitSource"),
    });
    if (!result.success) {
      setValidation(
        result.error.issues.find((issue) => issue.path.length === 0)?.message ??
          "请核对委托价格、股数及涨跌停价。",
      );
      return;
    }
    setValidation("");
    prepare.mutate(result.data, {
      onSuccess: (data) => {
        setExpired(false);
        setPreview({ ...data, expiresAt: startedAt + previewLifetime });
      },
    });
  }

  function confirmOrder() {
    if (busy || !preview) return;
    if (Date.now() >= preview.expiresAt) {
      setExpired(true);
      return;
    }
    status.reset();
    setLastOrderId(preview.id);
    setPreview(null);
    confirm.mutate({ id: preview.id });
  }

  return {
    preview,
    expired,
    setPreview,
    prepareOrder,
    confirmOrder,
    lastOrderId,
    prepare,
    confirm,
    status,
    busy,
    validation,
  };
}

function MockOrderForm({
  orders,
  disabled,
  names,
}: {
  orders: ReturnType<typeof useMockOrders>;
  disabled: boolean;
  names: SecurityNames;
}) {
  const { preview, expired, prepare, confirm, status, lastOrderId } = orders;
  const busy = disabled || orders.busy;
  const previewError = orders.validation || prepare.error?.message;
  const receiptNos = status.data?.entrustNos ?? confirm.data?.entrustNos ?? [];
  return (
    <div className="space-y-3">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) orders.prepareOrder(new FormData(event.currentTarget));
        }}
      >
        <fieldset disabled={busy || preview !== null}>
          <FormGrid>
            <FormField label="证券代码">
              <Input
                name="symbol"
                placeholder="sh600519"
                required
                maxLength={8}
              />
            </FormField>
            <FormField label="买卖方向">
              <select
                name="side"
                className="h-9 w-full rounded-md border border-input bg-nc-field px-2 text-sm text-nc-text"
              >
                <option value="buy">买入</option>
                <option value="sell">卖出</option>
              </select>
            </FormField>
            <FormField label="委托价格（元）">
              <Input
                name="price"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </FormField>
            <FormField label="委托股数" hint="100 股的整数倍">
              <Input
                name="quantity"
                type="number"
                min="100"
                max="100000000"
                step="100"
                required
              />
            </FormField>
            <FormField label="当日跌停价（元）">
              <Input
                name="lowerLimit"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </FormField>
            <FormField label="当日涨停价（元）">
              <Input
                name="upperLimit"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </FormField>
            <FormField label="涨跌停依据">
              <Input
                name="limitSource"
                placeholder="例如当日行情终端"
                maxLength={200}
                required
              />
            </FormField>
          </FormGrid>
        </fieldset>
        <Button type="submit" size="sm" disabled={busy || preview !== null}>
          {prepare.isPending ? "正在预览…" : "预览模拟委托"}
        </Button>
      </form>
      {previewError && (
        <StateBanner state="error" title="无法预览模拟委托">
          {previewError}
        </StateBanner>
      )}
      {preview && (
        <div className="space-y-2">
          <StateBanner
            state="warn"
            title={expired ? "预览已过期，请重新预览" : "核对模拟委托"}
          >
            {preview.input.date} · {preview.input.symbol.toUpperCase()} ·{" "}
            {preview.input.side === "buy" ? "买入" : "卖出"} ·{" "}
            {tradeNumber(preview.input.quantity)} 股 ·{" "}
            {tradeNumber(preview.input.price)} 元/股
            <p>预览有效期 60 秒，确认后提交至同花顺模拟账户。</p>
          </StateBanner>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || expired}
              onClick={orders.confirmOrder}
            >
              确认模拟委托
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => orders.setPreview(null)}
            >
              {expired ? "返回委托表单" : "修改委托"}
            </Button>
          </div>
        </div>
      )}
      {lastOrderId && (
        <div className="space-y-2 border-t border-nc-border-soft pt-3">
          {confirm.isPending && <p role="status">正在提交模拟委托…</p>}
          {confirm.isSuccess && (
            <p role="status">
              已收到模拟委托回执
              {receiptNos.length > 0
                ? ` · 委托号 ${receiptNos.join("、")}`
                : " · 暂无可核验委托号"}
            </p>
          )}
          {confirm.error && (
            <StateBanner state="error" title="模拟委托未取得确认回执">
              {confirm.error.message}。请先查询委托状态再决定是否重新提交。
            </StateBanner>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => status.mutate({ id: lastOrderId })}
          >
            {status.isPending ? "正在查询…" : "查询委托状态"}
          </Button>
          {status.error && (
            <StateBanner state="error" title="委托状态查询失败">
              {status.error.message}
            </StateBanner>
          )}
          {status.data && (
            <MockStatusResult status={status.data} names={names} />
          )}
        </div>
      )}
    </div>
  );
}

function MockStatusResult({
  status,
  names,
}: {
  status: MockOrderStatus;
  names: SecurityNames;
}) {
  const label = {
    matched: "已查到关联成交",
    unfilled: "当日未查到关联成交",
    unknown: "委托成交状态未知",
  }[status.fillStatus];
  return (
    <>
      <StateBanner state={status.attributable ? "info" : "warn"} title={label}>
        {status.reason}
      </StateBanner>
      {status.rows.length > 0 && (
        <MockTradesTable label="关联成交" trades={status.rows} names={names} />
      )}
    </>
  );
}

type DetailTab = "positions" | "trades" | "order";

export function ThsMockAccountPanel() {
  const utils = api.useUtils();
  const meta = api.thsMockMeta.useQuery();
  const toggle = api.thsMockToggle.useMutation();
  const open = api.thsMockOpenAccount.useMutation(manualRequest);
  const recover = api.thsMockRecoverAccount.useMutation(manualRequest);
  const overview = api.thsMockOverview.useMutation(manualRequest);
  const orders = useMockOrders();
  const { data: names } = useSecurityNames();
  const [tab, setTab] = useState<DetailTab>("positions");
  const [message, setMessage] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const enabled = meta.data?.enabled === true;
  const hasAccountRecord = meta.data?.hasAccount === true;
  const opened = hasAccountRecord && !!meta.data?.marketCodes.length;
  const ready = enabled && opened;
  const accountBusy =
    toggle.isPending ||
    open.isPending ||
    recover.isPending ||
    overview.isPending;
  const busy = accountBusy || orders.busy;
  const snapshot = ready ? overview.data : undefined;
  const fund = snapshot?.funds.length === 1 ? snapshot.funds[0] : undefined;

  async function changeAccount(
    action: () => Promise<unknown>,
    success: string,
  ) {
    if (busy) return;
    setMessage(null);
    orders.setPreview(null);
    overview.reset();
    try {
      await action();
      setMessage({ text: success });
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "请检查模拟账户后重试。",
        error: true,
      });
    } finally {
      await utils.thsMockMeta.invalidate();
    }
  }

  return (
    <Panel
      title="同花顺模拟账户"
      tag={
        meta.data
          ? `${enabled ? "已开启" : "已关闭"} · ${opened ? "已开户" : "未开户"}`
          : undefined
      }
      bodyClassName="space-y-3"
    >
      <p className="text-sub text-nc-text-3">
        同花顺问财提供模拟炒股服务；开启本身不自动开户或轮询，所有远程操作由人工触发
      </p>
      {meta.isPending && <p role="status">正在读取模拟账户状态…</p>}
      {meta.error && (
        <StateBanner
          state="error"
          title="模拟账户状态读取失败"
          action={{ label: "重试", onClick: () => void meta.refetch() }}
        >
          {meta.error.message}
        </StateBanner>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!meta.data || busy || meta.isFetching}
          onClick={() =>
            void changeAccount(
              () => toggle.mutateAsync({ enabled: !enabled }),
              enabled ? "已关闭同花顺模拟" : "已开启同花顺模拟",
            )
          }
        >
          {enabled ? "关闭同花顺模拟" : "开启同花顺模拟"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!enabled || busy || meta.isFetching}
          onClick={() =>
            void changeAccount(() => open.mutateAsync(), "模拟账户已核验")
          }
        >
          {open.isPending ? "正在开户或核验…" : "开户 / 核验账户"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!enabled || !hasAccountRecord || busy || meta.isFetching}
          onClick={() =>
            void changeAccount(() => recover.mutateAsync(), "股东账号已核验")
          }
        >
          {recover.isPending ? "正在核验股东账号…" : "核验股东账号"}
        </Button>
        <Button
          size="sm"
          disabled={!ready || busy || meta.isFetching}
          onClick={() => {
            setMessage(null);
            overview.mutate();
          }}
        >
          {overview.isPending ? "正在刷新…" : "刷新资金与持仓"}
        </Button>
      </div>
      {enabled && hasAccountRecord && !opened && (
        <StateBanner state="warn" title="开户记录待核验">
          已有开户记录，请先核验股东账号。
        </StateBanner>
      )}
      {message && (
        <StateBanner
          state={message.error ? "error" : "info"}
          title={message.error ? "模拟账户操作失败" : message.text}
        >
          {message.error ? message.text : undefined}
        </StateBanner>
      )}
      {overview.error && (
        <StateBanner state="error" title="模拟账户刷新失败">
          {overview.error.message}
        </StateBanner>
      )}
      {snapshot && (
        <>
          <StatCards
            items={[
              { label: "资金余额（元）", value: tradeNumber(fund?.zjye) },
              { label: "可用资金（元）", value: tradeNumber(fund?.kyje) },
              {
                label: "持仓数量",
                value: snapshot.positions.length,
                note: "只",
              },
              {
                label: "当日成交笔数",
                value: snapshot.tradesAvailable ? snapshot.trades.length : "—",
                note: snapshot.tradesAvailable ? "笔" : "成交暂不可用",
              },
            ]}
          />
          <p className="text-sub text-nc-text-4">
            查询于{" "}
            {new Date(snapshot.fetchedAt).toLocaleString("zh-CN", {
              timeZone: "Asia/Shanghai",
            })}
            {!fund && " · 资金数据缺失或存在多条余额记录"}
          </p>
        </>
      )}
      <Segmented
        label="同花顺模拟账户明细"
        value={tab}
        onChange={setTab}
        options={[
          { value: "positions", label: "持仓" },
          { value: "trades", label: "当日成交" },
          { value: "order", label: "模拟下单" },
        ]}
      />
      {ready && (
        <div hidden={tab !== "order"}>
          <MockOrderForm
            orders={orders}
            names={names}
            disabled={accountBusy || meta.isFetching}
          />
        </div>
      )}
      {tab === "order" ? (
        !ready && (
          <StateBanner
            state="empty"
            title="开启并核验同花顺模拟账户后可预览委托"
          />
        )
      ) : snapshot ? (
        tab === "positions" ? (
          <MockPositionsTable positions={snapshot.positions} names={names} />
        ) : snapshot.tradesAvailable ? (
          <MockTradesTable
            label="同花顺模拟当日成交"
            trades={snapshot.trades}
            names={names}
          />
        ) : (
          <StateBanner state="warn" title="当日成交暂不可用" />
        )
      ) : (
        <StateBanner
          state="empty"
          title={
            ready
              ? "点击刷新资金与持仓，读取账户概览"
              : "开启并核验同花顺模拟账户后可查询概览"
          }
        />
      )}
    </Panel>
  );
}
