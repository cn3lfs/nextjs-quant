"use client";

import {
  ArrowsClockwise,
  Broadcast,
  ListMagnifyingGlass,
  Plus,
  StopCircle,
} from "@phosphor-icons/react/ssr";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Panel, StateBanner } from "~/components/panels";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { chinaDate } from "~/lib/market/security-trading-status";
import { api } from "~/trpc/react";
import { DeployStrategyDialog } from "./deploy-strategy-dialog";
import { DeploymentCard } from "./pipeline-detail";
import { PipelineInbox, type PipelineInboxRow } from "./pipeline-inbox";

const liveConfirmationPhrase = "ENABLE_LIVE_TRADING";

export function PipelineConsole() {
  const utils = api.useUtils();
  const linkedId = useSearchParams().get("deployment") ?? "";
  const [deployOpen, setDeployOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const config = api.pipelineGlobalConfig.useQuery();
  const deployments = api.deploymentList.useInfiniteQuery(
    { limit: 50 },
    { getNextPageParam: ({ nextCursor }) => nextCursor ?? undefined },
  );
  const listed = deployments.data?.pages.flatMap(({ items }) => items) ?? [];
  const linkedInList = listed.some(({ id }) => id === linkedId);
  const linked = api.deploymentGet.useQuery(
    { id: linkedId },
    { enabled: Boolean(linkedId) && !linkedInList, retry: false },
  );
  const linkedData = linked.data;
  const items =
    linkedData && !linkedInList
      ? [
          {
            ...linkedData.deployment,
            activePoolCount: linkedData.activePool.length,
            latestRun: linkedData.runs[0] ?? null,
          },
          ...listed,
        ]
      : listed;
  const linkedAvailable = items.some(({ id }) => id === linkedId);
  useEffect(() => {
    if (linkedAvailable)
      document
        .getElementById(`deployment-${linkedId}`)
        ?.scrollIntoView({ block: "start" });
  }, [linkedAvailable, linkedId]);
  const activeWithRun = items.filter(
    ({ status, latestRun }) => status === "active" && latestRun,
  );
  const inboxQueries = api.useQueries((t) =>
    activeWithRun.map((deployment) =>
      t.pipelineRunDetail(
        { runId: deployment.latestRun!.id },
        { retry: false, staleTime: 15_000 },
      ),
    ),
  );
  const details = new Map(
    activeWithRun.map(({ id }, index) => [id, inboxQueries[index]]),
  );
  const inboxRows: PipelineInboxRow[] = items.map((deployment) => {
    const detail = details.get(deployment.id);
    return {
      deployment,
      run: detail?.data ?? null,
      error: detail?.error?.message,
    };
  });
  const refreshDeployments = () =>
    Promise.all([
      utils.deploymentList.invalidate(),
      utils.deploymentGet.invalidate(),
      utils.deploymentPoolList.invalidate(),
      utils.pipelineRunDetail.invalidate(),
    ]);
  const autoSim = api.pipelineSetGlobalAutoSim.useMutation({
    onSuccess: (data) => {
      utils.pipelineGlobalConfig.setData(undefined, (previous) =>
        previous ? { ...previous, autoSimEnabled: data.autoSimEnabled } : data,
      );
      setNotice(`模拟盘自动下单已${data.autoSimEnabled ? "开启" : "关闭"}。`);
      return utils.pipelineGlobalConfig.invalidate();
    },
  });
  const autoLive = api.pipelineSetGlobalAutoLive.useMutation({
    onSuccess: (data) => {
      utils.pipelineGlobalConfig.setData(undefined, (previous) =>
        previous
          ? { ...previous, autoLiveEnabled: data.autoLiveEnabled }
          : data,
      );
      setNotice(`实盘自动下单已${data.autoLiveEnabled ? "开启" : "关闭"}。`);
      setLiveOpen(false);
      setPhrase("");
      return utils.pipelineGlobalConfig.invalidate();
    },
  });
  const autoSimEnabled = config.data?.autoSimEnabled;
  const autoLiveEnabled = config.data?.autoLiveEnabled;

  const toggleExpanded = (id: string) =>
    setExpanded((previous) =>
      new Map(previous).set(id, !(previous.get(id) ?? id === linkedId)),
    );
  const openDeployment = (id: string) => {
    setExpanded((previous) => new Map(previous).set(id, true));
    if (typeof document !== "undefined")
      requestAnimationFrame(() =>
        document
          .getElementById(`deployment-${id}`)
          ?.scrollIntoView({ block: "start" }),
      );
  };

  return (
    <div className="space-y-4">
      <PipelineInbox
        rows={inboxRows}
        today={chinaDate(Date.now())}
        loading={deployments.isPending || inboxQueries.some((q) => q.isPending)}
        onOpen={openDeployment}
      />

      <Panel
        title="全局执行总开关"
        icon={Broadcast}
        meta="模拟与实盘分别控制"
        actions={
          <Button type="button" size="sm" onClick={() => setDeployOpen(true)}>
            <Plus size={14} aria-hidden="true" />
            新建部署
          </Button>
        }
        bodyClassName="space-y-2"
      >
        <div className="grid gap-2 lg:grid-cols-2">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2">
            <span className="text-sm font-medium text-nc-text">
              模拟盘自动下单
            </span>
            <span
              className="nc-status-chip"
              data-state={autoSimEnabled ? "ok" : "idle"}
            >
              <i aria-hidden="true" />
              {config.isPending
                ? "读取中"
                : autoSimEnabled === undefined
                  ? "—"
                  : autoSimEnabled
                    ? "已开启"
                    : "已关闭"}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={autoSim.isPending || autoSimEnabled === undefined}
              onClick={() => {
                setNotice("");
                autoSim.mutate({ enabled: !autoSimEnabled });
              }}
            >
              {autoSimEnabled ? "关闭自动模拟" : "开启自动模拟"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-nc-bad-edge bg-nc-inset px-3 py-2">
            <span className="text-sm font-medium text-nc-bad">
              实盘自动下单
            </span>
            <span
              className="nc-status-chip"
              data-state={autoLiveEnabled ? "bad" : "idle"}
            >
              <i aria-hidden="true" />
              {config.isPending
                ? "读取中"
                : autoLiveEnabled === undefined
                  ? "—"
                  : autoLiveEnabled
                    ? "已开启"
                    : "已关闭"}
            </span>
            {autoLiveEnabled !== false ? (
              <Button
                type="button"
                size="sm"
                variant="danger"
                className="ml-auto"
                disabled={autoLive.isPending}
                onClick={() => {
                  setNotice("");
                  autoLive.mutate({ enabled: false });
                }}
              >
                <StopCircle size={14} aria-hidden="true" />
                一键急停实盘
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="danger"
                className="ml-auto"
                disabled={autoLive.isPending}
                onClick={() => {
                  setPhrase("");
                  autoLive.reset();
                  setLiveOpen(true);
                }}
              >
                开启实盘自动
              </Button>
            )}
          </div>
        </div>
        <p className="m-0 text-[11px] text-nc-text-4">
          模拟盘开关控制自动模拟。实盘开关开启时，点击「一键急停实盘」可阻止新的实盘委托，包括人工确认的实盘单。
        </p>
        {notice && (
          <p role="status" className="m-0 text-[11px] text-nc-text-3">
            {notice}
          </p>
        )}
        {(config.error || autoSim.error || autoLive.error) && (
          <StateBanner
            state="error"
            title="总开关读取或设置失败"
            action={
              config.error
                ? { label: "重新读取", onClick: () => void config.refetch() }
                : undefined
            }
          >
            {config.error?.message ??
              autoSim.error?.message ??
              autoLive.error?.message}
          </StateBanner>
        )}
      </Panel>

      <Panel
        title="已部署策略"
        icon={ListMagnifyingGlass}
        meta={
          deployments.data
            ? `${deployments.hasNextPage ? "已加载 " : ""}${items.length} 个`
            : "—"
        }
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={deployments.isFetching}
            onClick={() => void refreshDeployments()}
          >
            <ArrowsClockwise size={14} aria-hidden="true" />
            刷新
          </Button>
        }
        bodyClassName="space-y-2"
      >
        {deployments.isPending && (
          <StateBanner state="info" title="正在读取策略部署…" hideIcon />
        )}
        {deployments.error && (
          <StateBanner
            state="error"
            title="策略部署读取失败"
            action={{
              label: "重试",
              onClick: () => void deployments.refetch(),
            }}
          >
            {deployments.error.message}
          </StateBanner>
        )}
        {linkedId && !linkedInList && linked.isPending && (
          <p role="status">正在读取对应策略部署…</p>
        )}
        {linkedId && !linkedInList && linked.error && (
          <StateBanner
            state="error"
            title="无法打开链接中的策略部署"
            action={{ label: "重试", onClick: () => void linked.refetch() }}
          >
            {linked.error.message}
          </StateBanner>
        )}
        {!deployments.isPending &&
          !deployments.error &&
          !(linkedId && linked.isPending) &&
          items.length === 0 && (
            <StateBanner
              state="empty"
              title="尚无策略部署"
              action={{ label: "新建部署", onClick: () => setDeployOpen(true) }}
            >
              部署后，每日选股、监控池、信号、风控与执行会按 5 段链路自动衔接。
            </StateBanner>
          )}
        {items.map((deployment) => (
          <DeploymentCard
            key={deployment.id}
            deployment={deployment}
            onChanged={refreshDeployments}
            expanded={expanded.get(deployment.id) ?? deployment.id === linkedId}
            showLatestRun={deployment.id === linkedId && !!deployment.latestRun}
            onToggle={() => toggleExpanded(deployment.id)}
          />
        ))}
        {deployments.hasNextPage && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={deployments.isFetching}
            onClick={() => void deployments.fetchNextPage()}
          >
            {deployments.isFetchingNextPage ? "正在加载…" : "加载更多"}
          </Button>
        )}
      </Panel>

      <DeployStrategyDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        onDeployed={(deploymentId) => {
          setNotice(`已创建策略部署 ${deploymentId}。`);
        }}
      />

      <Dialog
        open={liveOpen}
        onOpenChange={(next) => {
          if (!autoLive.isPending) setLiveOpen(next);
        }}
      >
        <DialogContent
          showCloseButton={!autoLive.isPending}
          className="lg:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>开启实盘自动下单</DialogTitle>
            <DialogDescription>
              开启后，自动实盘部署可在满足执行条件时发送真实委托，人工确认模式也可提交经审批的实盘单。请输入确认短语以继续。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="flex flex-col gap-1 text-sub text-nc-text-3">
              <span>
                确认短语：<code>{liveConfirmationPhrase}</code>
              </span>
              <Input
                aria-label="实盘确认短语"
                autoComplete="off"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                placeholder={liveConfirmationPhrase}
              />
            </label>
            {autoLive.error && (
              <p role="alert" className="m-0 text-[11px] text-nc-bad">
                {autoLive.error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={autoLive.isPending}
              onClick={() => setLiveOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={phrase !== liveConfirmationPhrase || autoLive.isPending}
              onClick={() => {
                setNotice("");
                autoLive.mutate({
                  enabled: true,
                  confirmationPhrase: phrase,
                });
              }}
            >
              {autoLive.isPending ? "正在开启…" : "确认开启实盘自动"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
