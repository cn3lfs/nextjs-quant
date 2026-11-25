"use client";

import Link from "next/link";
import { useState } from "react";
import { venueBindingSchema } from "trading-strategies";
import { api, type RouterOutputs } from "~/trpc/react";
import { ChartSymbolLink } from "../market/chart-symbol-link";
import { useSecurityNames } from "../market/use-security-names";
import { normalizeChartSymbol } from "~/lib/chart/chart-symbol";
import {
  FormField,
  FormGrid,
  GridTable,
  Panel,
  Pill,
  StatCards,
  StateBanner,
} from "../panels";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { tradeNumber } from "./trade-workspace-fields";

type LiveAccount = RouterOutputs["thsLiveAccountsList"][number];
type Snapshot = RouterOutputs["thsLiveAccountSnapshot"];
type SecurityNames = ReturnType<typeof useSecurityNames>["data"];

function LiveAccountEditor({
  account,
  disabled,
  onChange,
}: {
  account?: LiveAccount;
  disabled?: boolean;
  onChange?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const utils = api.useUtils();

  async function save(form: HTMLFormElement) {
    if (saving) return;
    const fields = new FormData(form);
    const name = String(fields.get("name") ?? "").trim();
    const accountId =
      account?.accountId ?? String(fields.get("accountId") ?? "").trim();
    const endpointUrl = String(fields.get("endpointUrl") ?? "").trim();
    const credential = form.elements.namedItem("token");
    const token =
      credential instanceof HTMLInputElement ? credential.value.trim() : "";
    if (!name || !accountId) {
      setError("请填写账户名称和实盘账户 ID。");
      return;
    }
    const binding = venueBindingSchema.safeParse({
      kind: "cn_broker_live",
      broker: "ths_live",
      accountId,
      endpointUrl,
    });
    if (!binding.success) {
      setError(
        "桥接地址须使用 HTTPS 或本机 HTTP，且不能含凭据、查询参数或片段。",
      );
      return;
    }
    if (
      token &&
      [name, accountId, endpointUrl].some((field) => field.includes(token))
    ) {
      setError("账户名称、ID 和桥接地址不能包含鉴权令牌。");
      return;
    }
    if (credential instanceof HTMLInputElement) credential.value = "";
    setError("");
    setSaving(true);
    try {
      // Submit directly so the token never enters the query client's mutation cache.
      await utils.client.thsLiveAccountSave.mutate({
        id: account?.id,
        name,
        accountId,
        endpointUrl,
        ...(token ? { token } : {}),
      });
      setOpen(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "实盘账户保存失败，请重试。";
      setError(token ? message.split(token).join("[已隐藏]") : message);
    } finally {
      onChange?.();
      await utils.thsLiveAccountsList.invalidate();
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        setError("");
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant={account ? "outline" : "default"}
          disabled={disabled || saving}
        >
          {account ? "编辑账户" : "登记实盘账户"}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!saving}>
        <DialogTitle>
          {account ? "编辑同花顺实盘账户" : "登记同花顺实盘账户"}
        </DialogTitle>
        <DialogDescription>
          鉴权令牌通过 Windows DPAPI
          加密保存。凭证与桥接源绑定，更换桥接源时请填写对应令牌。
        </DialogDescription>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save(event.currentTarget);
          }}
        >
          <fieldset disabled={saving}>
            <FormGrid>
              <FormField label="账户名称" wide>
                <Input
                  name="name"
                  defaultValue={account?.name}
                  placeholder="同花顺实盘主账户"
                  required
                />
              </FormField>
              <FormField
                label="实盘账户 ID"
                wide
                hint={account ? "账户 ID 在登记时确定" : undefined}
              >
                <Input
                  name="accountId"
                  defaultValue={account?.accountId}
                  readOnly={!!account}
                  required
                />
              </FormField>
              <FormField label="本地桥接地址" wide>
                <Input
                  name="endpointUrl"
                  type="url"
                  defaultValue={account?.endpointUrl}
                  placeholder="https://127.0.0.1:8848"
                  required
                />
              </FormField>
              <FormField label="鉴权令牌 Token" wide>
                <Input
                  name="token"
                  type="password"
                  autoComplete="new-password"
                  placeholder="留空保持已保存的 DPAPI 凭证不变"
                />
              </FormField>
            </FormGrid>
          </fieldset>
          {error && (
            <StateBanner state="error" title="无法保存实盘账户">
              {error}
            </StateBanner>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={saving}>
                取消
              </Button>
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving ? "正在保存…" : "保存账户"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LiveAccountDelete({
  account,
  disabled,
}: {
  account: LiveAccount;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const utils = api.useUtils();
  const remove = api.thsLiveAccountDelete.useMutation({
    retry: false,
    networkMode: "always",
    onSuccess: async () => {
      setOpen(false);
      await utils.thsLiveAccountsList.invalidate();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (remove.isPending) return;
        remove.reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="danger" disabled={disabled}>
          删除账户
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!remove.isPending}>
        <DialogTitle>删除同花顺实盘账户</DialogTitle>
        <DialogDescription>
          将删除「{account.name}」的本地登记与 DPAPI
          凭证，使用该凭证的策略部署将无法连接桥接。
        </DialogDescription>
        {remove.error && (
          <StateBanner state="error" title="删除实盘账户失败">
            {remove.error.message}
          </StateBanner>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={remove.isPending}>
              取消
            </Button>
          </DialogClose>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ id: account.id })}
          >
            {remove.isPending ? "正在删除…" : "确认删除账户"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LiveSnapshot({
  data,
  names,
}: {
  data: Snapshot;
  names: SecurityNames;
}) {
  return (
    <>
      <StatCards
        items={[
          { label: "可用资金（元）", value: tradeNumber(data.cash) },
          { label: "账户权益（元）", value: tradeNumber(data.equity) },
          {
            label: "回撤",
            value:
              data.drawdownPct === null
                ? "—"
                : `${tradeNumber(data.drawdownPct * 100)}%`,
          },
        ]}
      />
      <p className="text-sub text-nc-text-4">
        查询于{" "}
        {new Date(data.fetchedAt).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
        })}
      </p>
      <GridTable
        label="同花顺实盘持仓"
        rows={data.positions}
        rowKey={(row, index) => `${row.symbol}:${index}`}
        minWidth={420}
        empty="暂无持仓"
        columns={[
          {
            key: "symbol",
            header: "标的",
            width: "1.8fr",
            cell: (row) => {
              const symbol = normalizeChartSymbol(row.symbol);
              return symbol ? (
                <ChartSymbolLink symbol={symbol} name={names?.[symbol]} />
              ) : (
                row.symbol
              );
            },
          },
          {
            key: "quantity",
            header: "持仓数量",
            align: "right",
            cell: (row) => tradeNumber(row.quantity),
          },
          {
            key: "sellable",
            header: "可卖数量",
            align: "right",
            cell: (row) => tradeNumber(row.sellable),
          },
          {
            key: "lastPrice",
            header: "最新价（元）",
            align: "right",
            cell: (row) =>
              row.lastPrice === null
                ? "—"
                : row.lastPrice.toLocaleString("zh-CN", {
                    maximumFractionDigits: 4,
                  }),
          },
        ]}
      />
    </>
  );
}

function LiveAccountDetails({
  account,
  enabled,
  names,
}: {
  account: LiveAccount;
  enabled: boolean;
  names: SecurityNames;
}) {
  const snapshot = api.thsLiveAccountSnapshot.useMutation({
    retry: false,
    networkMode: "always",
  });
  return (
    <article
      className="space-y-3 border-t border-nc-border-soft pt-3"
      aria-label={account.name}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="break-all text-base font-semibold">
              {account.name}
            </h4>
            <Pill tone={account.hasCredential ? "ok" : "warn"}>
              DPAPI 凭证：{account.hasCredential ? "已配置" : "未配置"}
            </Pill>
          </div>
          <p className="break-all text-sub text-nc-text-3">
            实盘账户 ID：{account.accountId} · {account.endpointUrl}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!enabled || !account.hasCredential || snapshot.isPending}
            onClick={() => snapshot.mutate({ id: account.id })}
          >
            {snapshot.isPending
              ? "正在读取实盘账户…"
              : "只读刷新实盘资金与持仓"}
          </Button>
          <LiveAccountEditor
            account={account}
            disabled={snapshot.isPending}
            onChange={snapshot.reset}
          />
          <LiveAccountDelete account={account} disabled={snapshot.isPending} />
        </div>
      </div>
      {snapshot.error && (
        <StateBanner state="error" title="实盘查账失败">
          {snapshot.error.message.replace(/^live-kill-switch-off[：:]\s*/, "")}
        </StateBanner>
      )}
      {snapshot.data && <LiveSnapshot data={snapshot.data} names={names} />}
    </article>
  );
}

export function ThsLiveAccountPanel() {
  const accounts = api.thsLiveAccountsList.useQuery();
  const global = api.pipelineGlobalConfig.useQuery(undefined, {
    refetchOnMount: "always",
  });
  const { data: names } = useSecurityNames();
  const enabled = global.data?.autoLiveEnabled;

  return (
    <Panel title="同花顺实盘账户" tone="warn" bodyClassName="space-y-3">
      <StateBanner
        state="warn"
        title="实盘通道 · 仅查账与凭证管理，不在此页自动下单"
      >
        <span className="mr-2">
          全局实盘总开关：
          {enabled === true
            ? "已开启"
            : enabled === false
              ? "未开启"
              : global.isError
                ? "读取失败"
                : "读取中…"}
        </span>
        <Link
          href="/?tab=pipeline"
          className="text-primary underline underline-offset-2"
        >
          策略运行台
        </Link>
        {enabled === false && <p>开启全局实盘总开关后可手动查账。</p>}
      </StateBanner>
      <LiveAccountEditor disabled={!accounts.data} />
      {accounts.isPending && <p role="status">正在读取已登记的实盘账户…</p>}
      {accounts.error && (
        <StateBanner
          state="error"
          title="实盘账户读取失败"
          action={{ label: "重试", onClick: () => void accounts.refetch() }}
        >
          {accounts.error.message}
        </StateBanner>
      )}
      {accounts.data?.length === 0 && (
        <StateBanner state="empty" title="暂无已登记的同花顺实盘账户" />
      )}
      {accounts.data?.map((account) => (
        <LiveAccountDetails
          key={account.id}
          account={account}
          enabled={enabled === true}
          names={names}
        />
      ))}
    </Panel>
  );
}
