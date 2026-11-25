"use client";

import { ClipboardText } from "@phosphor-icons/react/ssr";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { formatNumber } from "trading-strategy-core/format-number";
import { targetSnapshotSchema } from "~/lib/research/alpha-experiment";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import {
  GridTable,
  Panel,
  Pill,
  Segmented,
  StateBanner,
  type Column,
} from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useNow } from "../workbench/use-now";
import { useScreenVisible } from "../workbench/use-task-visible";

type ListInput = RouterInputs["rebalanceTicketList"];
type AccountScope = ListInput["accountScope"];
type Cursor = NonNullable<ListInput["after"]>;
type Ticket = RouterOutputs["rebalanceTicketGenerate"];
type Order = Ticket["orders"][number];
type Recheck = NonNullable<Ticket["recheckResult"]>;
type Check = Recheck["checks"][number];
type TicketSource = RouterInputs["rebalanceTicketGenerate"]["source"];

const accountScopes = [
  { value: "real", label: "真实账本" },
  { value: "paper", label: "纸面账本" },
] as const;
const ticketStatus = {
  draft: ["待确认", "idle"],
  confirmed: ["已确认", "accent"],
  rechecked: ["已复检", "accent"],
  expired: ["已过期", "warn"],
  cancelled: ["已取消", "idle"],
} as const;
const checkStatus = {
  passed: ["通过", "ok"],
  warning: ["警告", "warn"],
  unknown: ["待核验", "warn"],
  blocked: ["阻断", "bad"],
  conditional: ["有条件通过", "warn"],
} as const;
const sourceLabel = {
  manual: "手工目标",
  studio: "策略工作室",
  alpha: "Alpha 快照",
  etf_rotation: "ETF 轮动",
} as const;
const sourceOptions = [
  { value: "manual", label: sourceLabel.manual },
  { value: "alpha", label: sourceLabel.alpha },
  { value: "etf_rotation", label: "ETF / 宏观 / 配对" },
  { value: "studio", label: sourceLabel.studio },
] as const;
type UiSourceKind = (typeof sourceOptions)[number]["value"];
type EtfPresetId = Extract<
  TicketSource,
  { kind: "etf_rotation_preset" }
>["strategyId"];
type PairPresetId = Extract<
  TicketSource,
  { kind: "pair_switch_preset" }
>["pairId"];
type EtfPresetSource = Extract<
  TicketSource,
  { kind: "etf_rotation_preset" | "macro_clock_preset" | "pair_switch_preset" }
>;
const macroClockSelection = "macro-clock";
const pairSelectionPrefix = "pair:";
const ticketPanelId = "rebalance-tickets";
const pairPresets = [
  { id: "hs300-zz500", label: "沪深300 / 中证500" },
  { id: "dividend-chinext", label: "红利 / 创业板" },
  { id: "gold-treasury", label: "黄金 / 国债" },
] as const satisfies readonly { id: PairPresetId; label: string }[];
/** Resolve the dropdown value into a zero-JSON preset source. */
function readEtfPresetSource(
  selection: string,
  etfPresets: readonly { id: EtfPresetId }[],
): EtfPresetSource | null {
  if (selection === macroClockSelection) return { kind: "macro_clock_preset" };
  if (selection.startsWith(pairSelectionPrefix)) {
    const preset = pairPresets.find(
      (item) => pairSelectionPrefix + item.id === selection,
    );
    return preset ? { kind: "pair_switch_preset", pairId: preset.id } : null;
  }
  const preset = etfPresets.find((item) => item.id === selection);
  return preset ? { kind: "etf_rotation_preset", strategyId: preset.id } : null;
}
type ResearchDeepLink = {
  sourceKind: UiSourceKind | null;
  etfStrategy: string | null;
  alphaJobId: string | null;
};

const beijingDateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "medium",
  timeStyle: "short",
});

export function RebalanceTicketPanel({
  decisionDate,
}: {
  decisionDate: string | null;
}) {
  const search = useSearchParams();
  const [opened, setOpened] = useState(false);
  const [deepLink, setDeepLink] = useState<ResearchDeepLink | null>(null);
  useEffect(() => {
    const raw = search.get("ticketSource");
    const sourceKind =
      raw === "etf_rotation" || raw === "alpha" || raw === "studio"
        ? raw
        : null;
    const linkedToPanel = window.location.hash === `#${ticketPanelId}`;
    if (!sourceKind && !linkedToPanel) return;
    setOpened(true);
    setDeepLink({
      sourceKind,
      etfStrategy: search.get("etfStrategy"),
      alphaJobId: search.get("alphaJobId"),
    });
    if (sourceKind && linkedToPanel)
      document.getElementById(ticketPanelId)?.scrollIntoView();
  }, [search]);
  return (
    <Panel
      id={ticketPanelId}
      icon={ClipboardText}
      title="次日调仓计划单"
      meta="先卖后买 · 人工确认"
      note="计划单用于人工核对。生成、确认、复检及取消均不下单。"
      actions={
        !opened && (
          <Button size="sm" variant="outline" onClick={() => setOpened(true)}>
            查看计划单
          </Button>
        )
      }
      bodyClassName={opened ? "space-y-4" : undefined}
    >
      {opened && (
        <TicketAccounts decisionDate={decisionDate} deepLink={deepLink} />
      )}
    </Panel>
  );
}

function TicketAccounts({
  decisionDate,
  deepLink,
}: {
  decisionDate: string | null;
  deepLink: ResearchDeepLink | null;
}) {
  const visible = useScreenVisible();
  const [scope, setScope] = useState<AccountScope>("real");
  const [selection, setSelection] = useState<
    Partial<Record<AccountScope, string>>
  >({});
  // Kept above AccountTickets so switching scope or account (which remounts
  // the ticket list) does not discard the user's chosen decision date.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const accounts = api.accountPortfolioRisk.useQuery(
    { scope },
    {
      enabled: visible,
      staleTime: 60_000,
      retry: false,
      select: (result) => result.accounts,
    },
  );
  const accountId = accounts.data?.find((id) => id === selection[scope]);
  // A one-click handoff should land on the ticket form; selecting the first
  // available account only changes the view context and generates nothing.
  useEffect(() => {
    if (!deepLink || selection[scope] || !accounts.data?.length) return;
    const first = accounts.data[0];
    if (first)
      setSelection((current) =>
        current[scope] ? current : { ...current, [scope]: first },
      );
  }, [accounts.data, deepLink, scope, selection]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="调仓账本类型"
          options={accountScopes}
          value={scope}
          onChange={setScope}
        />
        <Select
          value={accountId ?? ""}
          onValueChange={(id) =>
            setSelection((current) => ({ ...current, [scope]: id }))
          }
        >
          <SelectTrigger
            aria-label="调仓账户"
            disabled={accounts.isError || !accounts.data?.length}
            className="max-w-full"
          >
            <SelectValue placeholder="选择 A 股账户" />
          </SelectTrigger>
          <SelectContent>
            {accounts.data?.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {accounts.isError ? (
        <StateBanner
          state="error"
          title="账本列表读取失败"
          action={{ label: "重试", onClick: () => void accounts.refetch() }}
        >
          {accounts.error.message}
        </StateBanner>
      ) : !accounts.data ? (
        <p className="text-sub text-nc-text-3" role="status">
          正在读取账本…
        </p>
      ) : accounts.data.length === 0 ? (
        <StateBanner state="empty" title="此账本类型下暂无人民币 A 股账户" />
      ) : accountId ? (
        <AccountTickets
          key={JSON.stringify([scope, accountId, deepLink])}
          accountScope={scope}
          accountId={accountId}
          asOfDate={selectedDate ?? decisionDate ?? ""}
          onAsOfDateChange={setSelectedDate}
          deepLink={deepLink}
        />
      ) : (
        <p className="text-sub text-nc-text-3">
          选择账户后可查看计划单并生成新计划。
        </p>
      )}
    </>
  );
}

function readTicketSource(
  kind: UiSourceKind,
  form: FormData,
  picks: {
    etfRaw: boolean;
    alphaRaw: boolean;
    etfPreset: EtfPresetSource | null;
    alphaJobId: string | null;
  },
): TicketSource {
  if (kind === "studio") {
    const paperAccountId = String(form.get("paperAccountId") ?? "").trim();
    const strategyId = String(form.get("strategyId") ?? "").trim();
    if (!paperAccountId || !strategyId)
      throw new Error("请选择冻结目标所在的纸面账户并填写策略 ID。");
    return { kind, paperAccountId, strategyId };
  }
  if (kind === "etf_rotation" && !picks.etfRaw) {
    if (!picks.etfPreset)
      throw new Error("请选择 ETF 轮动、宏观时钟或现货配对预设。");
    return picks.etfPreset;
  }
  if (kind === "alpha" && !picks.alphaRaw) {
    if (!picks.alphaJobId)
      throw new Error("请选择该决策日已完成的 Alpha 评估任务。");
    return { kind: "alpha_job", jobId: picks.alphaJobId };
  }
  if (kind !== "manual") {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(String(form.get("snapshot") ?? ""));
    } catch {
      throw new Error("请粘贴完整的冻结目标 JSON。");
    }
    if (kind === "alpha") {
      const parsed = targetSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) throw new Error("Alpha 冻结目标快照格式不完整。");
      return { kind, snapshot: parsed.data };
    }
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
      throw new Error("请粘贴决策日对应的一条 ETF 轮动冻结目标。");
    // The procedure validates the ETF row and binds its dates, symbols and digest.
    return {
      kind,
      snapshot: snapshot as Extract<
        TicketSource,
        { kind: typeof kind }
      >["snapshot"],
    };
  }
  const targets: Record<string, number> = {};
  let total = 0;
  const lines = String(form.get("targets") ?? "")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    const parts = /^(sh|sz|bj)(\d{6})\s+([0-9]+(?:\.[0-9]+)?)\s*%?$/i.exec(
      line.trim(),
    );
    const symbol = parts ? `${parts[1]?.toLowerCase()}${parts[2]}` : "";
    const percent = Number(parts?.[3]);
    if (
      !symbol ||
      !Number.isFinite(percent) ||
      percent > 100 ||
      Object.hasOwn(targets, symbol)
    )
      throw new Error(
        `第 ${index + 1} 行应为唯一的市场代码和 0–100 的百分比，例如 sh600000 10。`,
      );
    targets[symbol] = percent / 100;
    total += percent;
  }
  if (!lines.length || lines.length > 500 || total > 100 + 1e-10)
    throw new Error("请填写 1–500 个标的，目标仓位合计须不超过 100%。");
  const sourceRefId =
    String(form.get("reference") ?? "").trim() || "作战室手工计划";
  return { kind, sourceRefId, targets };
}

function StudioSourceFields({
  disabled,
  visible,
}: {
  disabled: boolean;
  visible: boolean;
}) {
  const [paperAccountId, setPaperAccountId] = useState("");
  const strategyList = useId();
  const accounts = api.paperAccounts.useQuery(undefined, {
    enabled: visible,
    retry: false,
  });
  const detail = api.paperAccount.useQuery(paperAccountId, {
    enabled: visible && !!paperAccountId,
    retry: false,
  });
  const equityAccounts = accounts.data?.filter(
    (account) => account.market === "cn-equity" && account.currency === "CNY",
  );
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sub text-nc-text-2">
        冻结策略的纸面账户
        <Select
          name="paperAccountId"
          required
          value={paperAccountId}
          onValueChange={setPaperAccountId}
        >
          <SelectTrigger disabled={disabled || !equityAccounts?.length}>
            <SelectValue placeholder="选择纸面账户" />
          </SelectTrigger>
          <SelectContent>
            {equityAccounts?.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.name ?? account.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="grid gap-1 text-sub text-nc-text-2">
        策略 ID
        <Input
          key={paperAccountId}
          name="strategyId"
          list={strategyList}
          required
          maxLength={200}
          disabled={disabled || !paperAccountId}
        />
        <datalist id={strategyList}>
          {detail.data?.candidates.map(({ id }) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      </label>
      {accounts.isError && (
        <span className="text-sub" role="status">
          纸面账户读取失败
        </span>
      )}
      {equityAccounts?.length === 0 && (
        <span className="text-sub" role="status">
          暂无人民币 A 股纸面账户
        </span>
      )}
    </div>
  );
}

function AccountTickets({
  accountScope,
  accountId,
  asOfDate,
  onAsOfDateChange,
  deepLink,
}: ListInput & {
  asOfDate: string;
  onAsOfDateChange: (value: string) => void;
  deepLink: ResearchDeepLink | null;
}) {
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(deepLink !== null);
  const [sourceKind, setSourceKind] = useState<UiSourceKind>(
    deepLink?.sourceKind ?? "manual",
  );
  const [etfSelection, setEtfSelection] = useState(deepLink?.etfStrategy ?? "");
  const [alphaJobId, setAlphaJobId] = useState(deepLink?.alphaJobId ?? "");
  const [etfRaw, setEtfRaw] = useState(false);
  const [alphaRaw, setAlphaRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = useScreenVisible();
  const utils = api.useUtils();
  const account = { accountScope, accountId };
  const after = cursors.at(-1);
  const sources = api.rebalanceTicketSources.useQuery(
    { asOfDate: asOfDate || undefined },
    { enabled: visible && showForm, retry: false },
  );
  const etfPresets = sources.data?.etfPresets ?? [];
  const alphaJobs = sources.data?.alphaJobs ?? [];
  // A deep-linked id must never silently degrade into a different strategy:
  // fall back to the first option only when no explicit choice was supplied.
  const etfSelectionValue = etfSelection || (etfPresets[0]?.id ?? "");
  const etfPreset = readEtfPresetSource(etfSelectionValue, etfPresets);
  const alphaJob = alphaJobId
    ? (alphaJobs.find((job) => job.id === alphaJobId) ?? null)
    : (alphaJobs[0] ?? null);
  const sourceReady =
    sourceKind === "manual" || sourceKind === "studio"
      ? true
      : sourceKind === "etf_rotation"
        ? etfRaw || etfPreset !== null
        : alphaRaw || alphaJob !== null;
  const list = api.rebalanceTicketList.useQuery(
    { ...account, after },
    { enabled: visible, retry: false },
  );
  const generate = api.rebalanceTicketGenerate.useMutation();
  const confirm = api.rebalanceTicketConfirm.useMutation();
  const recheck = api.rebalanceTicketRecheck.useMutation();
  const cancel = api.rebalanceTicketCancel.useMutation();
  const items = list.data?.items ?? [];
  const next = list.data?.nextCursor;
  const ticket = items.find((item) => item.id === selected) ?? items[0];

  async function save(operation: () => Promise<Ticket>, generating = false) {
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      setSelected(result.id);
      if (generating) {
        setCursors([]);
        setShowForm(false);
      } else {
        utils.rebalanceTicketList.setData(
          { ...account, after },
          (page) =>
            page && {
              ...page,
              items: page.items.map((item) =>
                item.id === result.id ? result : item,
              ),
            },
        );
      }
      await utils.rebalanceTicketList.invalidate(account);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "计划单操作失败");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const source = readTicketSource(sourceKind, form, {
        etfRaw,
        alphaRaw,
        etfPreset,
        alphaJobId: alphaJob?.id ?? null,
      });
      const date = String(form.get("date") ?? "");
      void save(
        () => generate.mutateAsync({ ...account, asOfDate: date, source }),
        true,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "计划来源无效");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {items.length > 0 && (
          <Select
            value={ticket?.id ?? ""}
            disabled={busy}
            onValueChange={setSelected}
          >
            <SelectTrigger aria-label="选择调仓计划单" className="max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {beijingDateTime.format(item.createdAt)} ·{" "}
                  {sourceLabel[item.sourceKind]} ·{" "}
                  {ticketStatus[item.status][0]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {cursors.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || list.isFetching}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            上一页
          </Button>
        )}
        {next && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || list.isFetching}
            onClick={() => setCursors([...cursors, next])}
          >
            下一页
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setError(null);
            setShowForm(!showForm);
          }}
          aria-expanded={showForm}
        >
          {showForm ? "收起目标表单" : "新建调仓计划"}
        </Button>
      </div>
      {showForm && (
        <form
          className="space-y-2 rounded-lg bg-nc-inset p-3"
          onSubmit={submit}
        >
          <Segmented
            label="目标来源"
            options={sourceOptions}
            value={sourceKind}
            onChange={(kind) => {
              if (busy) return;
              setSourceKind(kind);
              setError(null);
            }}
          />
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sub text-nc-text-2">
              决策日（最近已收盘交易日）
              <Input
                type="date"
                name="date"
                required
                value={asOfDate}
                onChange={(event) => onAsOfDateChange(event.target.value)}
                disabled={busy}
              />
            </label>
            {sourceKind === "manual" && (
              <label className="grid gap-1 text-sub text-nc-text-2">
                计划备注（选填）
                <Input name="reference" maxLength={200} disabled={busy} />
              </label>
            )}
          </div>
          {sourceKind === "studio" ? (
            <StudioSourceFields disabled={busy} visible={visible} />
          ) : sourceKind === "etf_rotation" && !etfRaw ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1 text-sub text-nc-text-2">
                  策略预设
                  <Select
                    value={etfSelectionValue}
                    onValueChange={setEtfSelection}
                  >
                    <SelectTrigger disabled={busy} className="min-w-64">
                      <SelectValue placeholder="选择 ETF / 宏观 / 配对预设" />
                    </SelectTrigger>
                    <SelectContent>
                      {etfPresets.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>ETF 轮动</SelectLabel>
                          {etfPresets.map((preset) => (
                            <SelectItem key={preset.id} value={preset.id}>
                              {preset.name}（v{preset.version}）
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      <SelectGroup>
                        <SelectLabel>宏观择时</SelectLabel>
                        <SelectItem value={macroClockSelection}>
                          宏观时钟 ETF 轮动
                        </SelectItem>
                      </SelectGroup>
                      <SelectGroup>
                        <SelectLabel>现货统计配对切换</SelectLabel>
                        {pairPresets.map((preset) => (
                          <SelectItem
                            key={preset.id}
                            value={pairSelectionPrefix + preset.id}
                          >
                            {preset.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setEtfRaw(true);
                    setError(null);
                  }}
                >
                  改用手工粘贴冻结 JSON
                </Button>
              </div>
              <p className="text-sub text-nc-text-3">
                按决策日生成冻结目标。宏观时钟使用本机可见的历史数据，配对切换要求两腿有连续的已收盘日线。
              </p>
              {sources.isError && (
                <p role="alert" className="text-sub text-nc-bad">
                  可用来源读取失败：{sources.error.message}
                </p>
              )}
            </div>
          ) : sourceKind === "alpha" && !alphaRaw ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1 text-sub text-nc-text-2">
                  已完成的 Alpha 评估
                  <Select
                    value={alphaJob?.id ?? ""}
                    onValueChange={setAlphaJobId}
                  >
                    <SelectTrigger
                      disabled={busy || !alphaJobs.length}
                      className="min-w-64"
                    >
                      <SelectValue
                        placeholder={
                          sources.isPending
                            ? "正在读取评估任务…"
                            : "选择该决策日可用的评估任务"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {alphaJobs.map((job) => (
                        <SelectItem key={job.id} value={job.id}>
                          {job.id} · {job.end} · {job.snapshotHash.slice(0, 8)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setAlphaRaw(true);
                    setError(null);
                  }}
                >
                  改用手工粘贴 targetSnapshot JSON
                </Button>
              </div>
              <p className="text-sub text-nc-text-3">
                直接引用已保存的冻结快照，无需复制 JSON。
              </p>
              {sources.isError && (
                <p role="alert" className="text-sub text-nc-bad">
                  可用来源读取失败：{sources.error.message}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <label className="grid gap-1 text-sub text-nc-text-2">
                {sourceKind === "manual"
                  ? "目标仓位（每行一个市场代码和百分比）"
                  : sourceKind === "alpha"
                    ? "Alpha 冻结目标（完整 targetSnapshot JSON）"
                    : "ETF 轮动冻结目标（决策日对应的一条 scheduledTargets JSON）"}
                <Textarea
                  key={sourceKind}
                  name={sourceKind === "manual" ? "targets" : "snapshot"}
                  required
                  placeholder={
                    sourceKind === "manual"
                      ? "sh600000 10\nsz159915 20"
                      : undefined
                  }
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              {sourceKind !== "manual" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (sourceKind === "etf_rotation") setEtfRaw(false);
                    else if (sourceKind === "alpha") setAlphaRaw(false);
                    setError(null);
                  }}
                >
                  改回自动选择
                </Button>
              )}
            </div>
          )}
          <p className="text-sub text-nc-text-3">
            未列出的持仓目标为 0%，剩余权重留作现金。请核对完整目标组合。
          </p>
          {!sourceReady && (
            <p role="status" className="text-sub text-nc-text-3">
              {sourceKind === "etf_rotation" && sources.isPending
                ? "正在读取 ETF 轮动预设…"
                : sourceKind === "etf_rotation" &&
                    etfSelectionValue &&
                    !etfPreset
                  ? `所选预设「${etfSelectionValue}」不在可用目录中，请重新选择或改用手工粘贴。`
                  : sourceKind === "alpha" && alphaJobId && !alphaJob
                    ? "URL 指定的 Alpha 评估不包含当前决策日的冻结目标，请更换决策日或改用手工粘贴。"
                    : `当前决策日没有可用的${sourceKind === "alpha" ? "已完成 Alpha 评估" : "ETF 轮动预设"}，请更换决策日或改用手工粘贴。`}
            </p>
          )}
          <Button type="submit" size="sm" disabled={busy || !sourceReady}>
            {generate.isPending ? "生成中…" : "生成计划单"}
          </Button>
        </form>
      )}
      {error && (
        <StateBanner state="error" title="计划单操作未完成">
          {error}
        </StateBanner>
      )}
      {list.isError && (
        <StateBanner
          state="error"
          title="计划单读取失败"
          action={{ label: "重试", onClick: () => void list.refetch() }}
        >
          {list.error.message}
        </StateBanner>
      )}
      {ticket ? (
        <TicketDetails
          key={ticket.id}
          ticket={ticket}
          busy={busy}
          disabled={list.isError || !visible}
          onConfirm={() =>
            void save(() => confirm.mutateAsync({ id: ticket.id }))
          }
          onRecheck={() =>
            void save(() => recheck.mutateAsync({ id: ticket.id }))
          }
          onCancel={() =>
            void save(() => cancel.mutateAsync({ id: ticket.id }))
          }
        />
      ) : list.data ? (
        <StateBanner state="empty" title="当前页暂无调仓计划单" />
      ) : (
        !list.isError && (
          <p className="text-sub text-nc-text-3" role="status">
            正在读取计划单…
          </p>
        )
      )}
    </div>
  );
}

function TicketDetails({
  ticket,
  busy,
  disabled,
  onConfirm,
  onRecheck,
  onCancel,
}: {
  ticket: Ticket;
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onRecheck: () => void;
  onCancel: () => void;
}) {
  const now = useNow(1000);
  const status =
    now !== null && now >= ticket.expiresAt && ticket.status !== "cancelled"
      ? "expired"
      : ticket.status;
  const [label, tone] = ticketStatus[status];
  const cutoff = Date.parse(`${ticket.executeDate}T09:30:00+08:00`);
  const opens = Date.parse(`${ticket.executeDate}T09:15:00+08:00`);
  const canConfirm =
    status === "draft" &&
    now !== null &&
    now < cutoff &&
    !!ticket.allocation &&
    ticket.orders.length > 0 &&
    ticket.riskSummary.checks.every((check) => check.status === "passed") &&
    ticket.orders.every(
      (order) =>
        order.estimate &&
        order.riskChecks.every((check) => check.status === "passed"),
    );
  const canRecheck =
    status === "confirmed" && now !== null && now >= opens && now < cutoff;
  const active = status !== "expired" && status !== "cancelled";
  const seconds =
    now === null
      ? null
      : Math.max(0, Math.ceil((ticket.expiresAt - now) / 1000));
  const warnings = [
    ...ticket.riskSummary.checks,
    ...ticket.orders.flatMap((order) => order.riskChecks),
  ].filter((check) => check.status !== "passed");
  return (
    <div className="space-y-3 border-t border-nc-border-soft pt-3">
      <div className="flex flex-wrap items-center gap-2 text-sub text-nc-text-3">
        <Pill tone={tone}>{label}</Pill>
        <span>
          决策日 {ticket.asOfDate} · 执行日 {ticket.executeDate}
        </span>
        {active && seconds !== null && (
          <span className="tabular-nums">
            距到期 {formatNumber(Math.floor(seconds / 3600), 0)} 时{" "}
            {formatNumber(Math.floor(seconds / 60) % 60, 0)} 分{" "}
            {formatNumber(seconds % 60, 0)} 秒
          </span>
        )}
        <span title="北京时间">
          到期 {beijingDateTime.format(ticket.expiresAt)}
        </span>
      </div>
      <p className="text-sub text-nc-text-3 [overflow-wrap:anywhere]">
        来源 {sourceLabel[ticket.sourceKind]} · {ticket.sourceRefId}
      </p>
      {ticket.executeDateNote && (
        <StateBanner state="warn" title="执行日待核验">
          {ticket.executeDateNote}
        </StateBanner>
      )}
      {ticket.orders.length > 0 ? (
        <div className="space-y-3">
          <OrderGroup side="sell" ticket={ticket} />
          <OrderGroup side="buy" ticket={ticket} />
        </div>
      ) : (
        <StateBanner state="empty" title="本计划无可执行调仓项" />
      )}
      {warnings.length > 0 && (
        <CheckList checks={warnings} label="生成时的核验提示" />
      )}
      <div className="flex flex-wrap items-center gap-2" aria-busy={busy}>
        {status === "draft" && (
          <Button
            size="sm"
            disabled={disabled || busy || !canConfirm}
            onClick={onConfirm}
          >
            人工确认计划
          </Button>
        )}
        {(status === "confirmed" || status === "draft") && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || busy || !canRecheck}
            onClick={onRecheck}
          >
            盘前复检
          </Button>
        )}
        {active && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || busy || now === null}
            onClick={onCancel}
          >
            取消计划
          </Button>
        )}
        {busy && (
          <span className="text-sub text-nc-text-3" role="status">
            计划单操作处理中…
          </span>
        )}
      </div>
      {active && !ticket.recheckResult && (
        <p className="text-sub text-nc-text-3">
          复检限执行日北京时间
          09:15–09:30，须先人工确认，每张计划单仅可复检一次。
        </p>
      )}
      {ticket.recheckResult && (
        <RecheckDetails result={ticket.recheckResult} at={ticket.recheckedAt} />
      )}
      {ticket.orders.length > 0 && (
        <p className="text-sub text-nc-text-4">{ticket.providerLimits}</p>
      )}
    </div>
  );
}

function OrderGroup({ side, ticket }: { side: Order["side"]; ticket: Ticket }) {
  const sell = side === "sell";
  const title = sell ? "先卖出" : "后买入";
  const orders = ticket.orders.filter((order) => order.side === side);
  const recheck = ticket.recheckResult?.checks;
  const buyColumns: Column<Order>[] = [
    {
      key: "atr",
      header: "Wilder ATR 止损价",
      align: "right",
      cell: (order) =>
        formatNumber(order.side === "buy" ? order.atrStopPrice : null, 3),
    },
    {
      key: "max",
      header: "拒追上限价",
      align: "right",
      cell: (order) =>
        formatNumber(order.side === "buy" ? order.maxBuyPrice : null, 3),
    },
    {
      key: "conditional",
      header: "依赖先卖回款",
      cell: (order) => (
        <Pill tone={order.conditional ? "warn" : "idle"}>
          {order.conditional ? "是" : "否"}
        </Pill>
      ),
    },
  ];
  return (
    <section aria-label={title}>
      <h4 className="mb-1 text-sub font-semibold text-nc-text">{title}</h4>
      <GridTable
        label={title}
        rows={orders}
        rowKey={(order) => `${order.side}:${order.symbol}`}
        minWidth={sell ? 660 : 920}
        empty={sell ? "无卖出计划" : "无买入计划"}
        columns={[
          {
            key: "symbol",
            header: "代码",
            cell: (order) => order.symbol.toUpperCase(),
          },
          { key: "side", header: "方向", cell: () => (sell ? "卖出" : "买入") },
          {
            key: "shares",
            header: "整手股数",
            align: "right",
            cell: (order) => formatNumber(order.quantity, 0),
          },
          {
            key: "notional",
            header: "预估金额（元）",
            align: "right",
            cell: (order) => formatNumber(order.estimate?.estimatedNotionalCny),
          },
          {
            key: "fee",
            header: "费用（元）",
            align: "right",
            cell: (order) => formatNumber(order.estimate?.estimatedFeesCny),
          },
          {
            key: "cash",
            header: sell ? "预计净回笼（元）" : "预计需资金（元）",
            align: "right",
            cell: (order) =>
              formatNumber(
                sell
                  ? order.estimate?.netSaleProceedsCny
                  : order.estimate?.cashRequiredCny,
              ),
          },
          ...(sell ? [] : buyColumns),
          {
            key: "market",
            header: "停牌 / 涨跌停",
            width: "1.5fr",
            cell: (order) => {
              const checks = recheck?.filter(
                (check) => check.symbol === order.symbol,
              );
              const market = checks?.filter(
                (check) => check.code === "halt" || check.code === "limits",
              );
              return market?.length
                ? market
                    .map(
                      (check) => check.detail ?? checkStatus[check.status][0],
                    )
                    .join(" · ")
                : checks?.some(
                      (check) =>
                        check.code === "quote" && check.status === "passed",
                    )
                  ? "复检无异常提示"
                  : "盘前待核验";
            },
          },
        ]}
      />
    </section>
  );
}

function CheckList({ checks, label }: { checks: Check[]; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-nc-border-soft">
      {checks.map((check, index) => {
        const [status, tone] = checkStatus[check.status];
        return (
          <li
            key={`${check.code}:${check.symbol ?? ""}:${index}`}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5 text-sub text-nc-text-3"
          >
            <Pill tone={tone}>{status}</Pill>
            {check.symbol && (
              <strong className="tabular-nums">
                {check.symbol.toUpperCase()}
              </strong>
            )}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {check.detail ?? check.code}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function RecheckDetails({
  result,
  at,
}: {
  result: Recheck;
  at: number | null;
}) {
  const [label, tone] = checkStatus[result.outcome];
  return (
    <section
      className="space-y-2 rounded-lg bg-nc-inset p-3"
      aria-label="盘前复检结果"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sub font-semibold text-nc-text">盘前复检结果</h4>
        <Pill tone={tone}>{label}</Pill>
        {at !== null && (
          <span className="text-sub tabular-nums text-nc-text-4">
            {beijingDateTime.format(at)}
          </span>
        )}
      </div>
      <CheckList checks={result.checks} label="逐项复检结论" />
    </section>
  );
}
