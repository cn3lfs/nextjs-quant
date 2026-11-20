import { MarketSourceSelect } from "../../market/market-source-select";
import Link from "next/link";
import { Database, FolderOpen } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, Pill, StatsPanel, type Tone } from "../../panels";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Button } from "../../ui/button";
import type { Settings } from "~/lib/domain";
import { Field, stamp } from "../shared";
import type { Coverage, FieldError, FieldProps } from "./shared";
import { useEffect, useState } from "react";
import { Switch } from "../../ui/switch";
import { api } from "~/trpc/react";

function CloseToTraySetting() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(Boolean(window.quantDesktop)), []);
  const utils = api.useUtils();
  const prefs = api.workspacePreferences.useQuery(undefined, {
    refetchOnWindowFocus: "always",
    refetchInterval: desktop ? 5000 : false,
  });
  const save = api.saveWorkspacePreferences.useMutation({
    onSuccess: async (saved) => {
      utils.workspacePreferences.setData(undefined, saved);
      await window.quantDesktop?.setCloseToTray?.(saved.closeToTray);
    },
  });
  return (
    <div className="mt-4 space-y-1">
      <label className="flex items-center gap-2">
        <Switch
          checked={prefs.data?.closeToTray ?? false}
          disabled={!prefs.data || save.isPending}
          onCheckedChange={(closeToTray) => save.mutate({ closeToTray })}
        />
        桌面端关闭窗口时最小化到托盘（保持后台扫描与提醒）
      </label>
      {!desktop && (
        <p className="text-[13px] text-nc-text-3">仅在桌面应用生效</p>
      )}
      {(save.isError || prefs.isError) && (
        <p role="alert">桌面设置同步失败，请重试。</p>
      )}
    </div>
  );
}

/** Compact THSDK status for the default-market-source callout. */
function thsdkCallout(
  status:
    | {
        enabled: boolean;
        configured: boolean;
        state: string;
      }
    | undefined,
): { label: string; tone: Tone } {
  if (!status) return { label: "读取状态…", tone: "idle" };
  if (status.state === "authenticated")
    return { label: "已认证可用", tone: "ok" };
  if (status.state === "error") return { label: "异常", tone: "bad" };
  if (!status.enabled) return { label: "当前未启用", tone: "idle" };
  if (!status.configured) return { label: "未配置 hq.dll", tone: "idle" };
  return { label: "未登录", tone: "warn" };
}

export function DataSection({
  config,
  setConfig,
  fieldProps,
  fieldError,
  dirty,
  savePending,
  scanning,
  onScan,
  value,
  coverage,
  onOpenThsdk,
}: {
  config: Settings;
  setConfig: (draft: Settings) => void;
  fieldProps: FieldProps;
  fieldError: FieldError;
  dirty: boolean;
  savePending: boolean;
  scanning: boolean;
  onScan: () => void;
  value: Settings;
  coverage: Coverage | null;
  onOpenThsdk?: () => void;
}) {
  const thsdk = api.thsdkStatus.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const callout = thsdkCallout(thsdk.data);
  return (
    <PageGrid>
      <Panel
        span={12}
        icon={FolderOpen}
        title="行情数据配置"
        actions={
          <Button
            variant="outline"
            disabled={scanning || dirty || savePending || !value.tdxRoot.trim()}
            onClick={onScan}
          >
            {scanning ? "正在扫描…" : "扫描已保存目录"}
          </Button>
        }
        note="行情请求只读。保存后用于新请求，已加载快照保留原始来源；行情页手动选择优先。"
      >
        {dirty && (
          <p className="mb-3 text-[13px] text-nc-warn">
            先保存当前修改，再扫描已保存的目录。
          </p>
        )}
        <Field label="通达信安装目录">
          <Input
            {...fieldProps("tdxRoot")}
            value={config.tdxRoot}
            onChange={(e) => setConfig({ ...config, tdxRoot: e.target.value })}
          />
        </Field>
        {fieldError("tdxRoot")}
        <p className="text-[13px] text-nc-text-3">
          填写通达信安装目录的绝对路径。留空表示尚未配置，读取该目录内的数据前需配置；
          在线行情和已导入日线包可独立使用。
        </p>
        <p className="text-[13px] text-nc-text-3">
          板块成分来源：
          {value.industryMembershipSource === "tdx" ? "通达信" : "外部 Blocks"}
          ； 外部目录：{value.industryBlocksRoot || "尚未配置"}。
          <Link href="/scan?tab=rps" className="underline">
            在 RPS → 行业中管理成分来源和目录
          </Link>
        </p>
        <Field label="默认行情数据源">
          <MarketSourceSelect
            value={config.marketDataSource}
            onChange={(marketDataSource) =>
              setConfig({ ...config, marketDataSource })
            }
          />
        </Field>
        <div className="mt-3 rounded-lg border border-nc-border-soft bg-nc-inset p-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-[13px] font-medium">
              同花顺行情（THSDK）
            </strong>
            <Pill tone={callout.tone}>{callout.label}</Pill>
          </div>
          <p className="mt-1 text-[13px] leading-[1.6] text-nc-text-3">
            需先配置本机 hq.dll 路径、打开启用开关并登录（支持账号密码或扫码）。
          </p>
          <div className="mt-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!onOpenThsdk}
              onClick={onOpenThsdk}
            >
              {thsdk.data?.state === "authenticated"
                ? "管理同花顺配置"
                : "前往配置并启用"}
            </Button>
          </div>
        </div>
        <details>
          <summary>交易日历参考（高级）</summary>
          <p className="text-nc-text-3">
            默认使用本地上证指数已有日期，并非完整官方日历。覆盖时每行输入一个已确认交易日，格式
            YYYY-MM-DD；留空恢复默认。
          </p>
          <Field label="交易日期覆盖">
            <Textarea
              {...fieldProps("calendar")}
              rows={4}
              value={config.calendar.join("\n")}
              onChange={(e) =>
                setConfig({
                  ...config,
                  calendar: e.target.value.split(/\s+/).filter(Boolean),
                })
              }
            />
          </Field>
          {fieldError("calendar")}
        </details>
        <CloseToTraySetting />
      </Panel>
      <StatsPanel
        icon={Database}
        title="本地行情覆盖"
        tag="只读接入"
        meta={
          coverage
            ? `最近扫描 ${stamp(coverage.scannedAt)} · ${coverage.total} 个 A 股周期记录（扫描时间不代表行情时点）`
            : "尚未扫描，保存目录后点击本页“扫描已保存目录”。"
        }
        items={[
          ...Object.entries(coverage?.counts ?? {}).map(([name, count]) => ({
            key: name,
            label: name.replace("day", "日线").replace("5m", "五分钟"),
            value: count.toLocaleString(),
            note: "行情文件",
          })),
        ]}
      />
    </PageGrid>
  );
}
