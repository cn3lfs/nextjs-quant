import { MarketSourceSelect } from "../market/market-source-select";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import {
  Books,
  ChatCircle,
  Database,
  FloppyDisk,
  FolderOpen,
  PaperPlaneTilt,
  Plus,
  Sparkle,
} from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, Pill, StatsPanel } from "../panels";
import { useEffect, useRef, useState } from "react";
import { settingsSchema, type Channel, type Settings } from "~/lib/domain";
import {
  acknowledgeSettings,
  changedSettings,
  reconcileSettings,
  settingsToSave,
} from "~/lib/settings/settings-draft";
import { usePanelVisible } from "./keep-alive";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";

import { Field, stamp } from "./shared";
import { NotificationPolicyFields } from "../signals/notification-policy-fields";
import { CryptoConnections } from "../common/crypto-connections";
import { ConnectionDiagnostics } from "./connection-diagnostics";
import { connectionConfiguration } from "~/lib/settings/connection-check";
import { sameSetting } from "~/lib/settings/settings-draft";
import { useSnapshotCache } from "~/lib/stores/snapshot-cache";

export function Connections({
  value,
  channels,
  coverage,
  notify,
}: {
  value: Settings;
  channels: Channel[];
  coverage: {
    counts: Record<string, number>;
    scannedAt: number;
    total: number;
  } | null;
  notify: (s: string) => void;
}) {
  const visible = usePanelVisible();
  const budget = api.newsBudget.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const skillCatalog = api.researchSkills.useQuery(undefined, {
    enabled: visible,
    staleTime: 60000,
  });
  const [draftState, setDraftState] = useState({ base: value, draft: value });
  const [saveError, setSaveError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const saving = useRef(false);
  const submittedDraft = useRef(value);
  const config = draftState.draft;
  const dirty = changedSettings(draftState).length > 0;
  const setConfig = (draft: Settings) => {
    setDraftState((state) => ({ ...state, draft }));
    setSaveError("");
    setFieldErrors({});
  };
  useEffect(() => {
    setDraftState((state) => reconcileSettings(state, value));
  }, [value]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const utils = api.useUtils(),
    [channel, setChannel] = useState({
      name: "",
      type: "feishu" as Channel["type"],
      target: "",
      thread: "",
      secret: "",
      signingSecret: "",
      enabled: false,
    }),
    [editId, setEditId] = useState<string | undefined>();
  const onError = (e: { message: string }) => notify(e.message),
    save = api.saveSettings.useMutation({
      onSuccess: (_result, submitted) => {
        if (
          !sameSetting(
            connectionConfiguration(draftState.base),
            connectionConfiguration(settingsSchema.parse(submitted)),
          )
        )
          useSnapshotCache.getState().clearMarket();
        setDraftState((state) =>
          acknowledgeSettings(
            state,
            settingsSchema.parse(submitted),
            submittedDraft.current,
          ),
        );
        setSaveError("");
        notify("设置已保存");
        void utils.status.invalidate();
        void utils.securityProfile.invalidate();
        void utils.securityNames.invalidate();
        void utils.securities.invalidate();
      },
      onError: (error) => {
        setSaveError(error.message);
        onError(error);
      },
      onSettled: () => {
        saving.current = false;
      },
    }),
    saveChannel = api.saveChannel.useMutation({
      onSuccess: () => {
        notify("渠道已保存，尚未发送测试消息");
        setChannel({ ...channel, secret: "", signingSecret: "" });
        void utils.channels.invalidate();
      },
      onError,
    }),
    test = api.testChannel.useMutation({
      onSuccess: () => notify("测试通知已加入发送队列，请查看投递历史"),
      onError,
    });
  const submitSettings = () => {
    if (!dirty || saving.current) return;
    const parsed = settingsSchema.safeParse(settingsToSave(draftState, value));
    const errors: Record<string, string> = {};
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        errors[String(issue.path[0])] = "请检查此项的格式或允许范围。";
    if (!config.tdxRoot.trim()) errors.tdxRoot = "请输入通达信安装目录。";
    if (!config.clsDbPath.trim())
      errors.clsDbPath = "请输入财联社新闻数据库路径。";
    if (
      config.calendar.some(
        (day) =>
          !Number.isFinite(Date.parse(day)) ||
          new Date(day).toISOString().slice(0, 10) !== day,
      )
    )
      errors.calendar = "请输入真实日期，格式为 YYYY-MM-DD，每行一个。";
    if (!parsed.success || Object.keys(errors).length) {
      setFieldErrors(errors);
      setSaveError("请检查目录、日期格式及数值范围后重试。设置尚未保存。");
      const first = document.getElementById(
        `setting-${Object.keys(errors)[0]}`,
      );
      const details = first?.closest("details");
      if (details) details.open = true;
      first?.focus();
      return;
    }
    saving.current = true;
    submittedDraft.current = config;
    setSaveError("");
    save.mutate(parsed.data);
  };
  const fieldProps = (name: string) => ({
    id: `setting-${name}`,
    "aria-invalid": Boolean(fieldErrors[name]),
    "aria-describedby": fieldErrors[name] ? `setting-error-${name}` : undefined,
  });
  const fieldError = (name: string) =>
    fieldErrors[name] && (
      <p id={`setting-error-${name}`} className="mb-2 text-nc-bad">
        {fieldErrors[name]}
      </p>
    );
  return (
    <PageGrid>
      <Panel
        title="数据与连接设置"
        icon={FolderOpen}
        className="sticky top-0 z-10"
        note="保存以下路径、行情源、研究与通知策略。聊天渠道和数字货币连接分别保存。"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            role="status"
            data-settings-state={
              save.isPending ? "saving" : dirty ? "dirty" : "saved"
            }
          >
            {save.isPending
              ? "正在保存；可以继续编辑"
              : dirty
                ? "有未保存的修改 · 切换页面会保留草稿"
                : "设置已保存"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setDraftState((state) => ({
                  base: state.base,
                  draft: state.base,
                }));
                setSaveError("");
                setFieldErrors({});
              }}
            >
              撤销修改
            </Button>
            <Button
              onClick={submitSettings}
              disabled={!dirty || save.isPending}
            >
              <FloppyDisk size={14} />
              保存设置
            </Button>
          </div>
        </div>
        {saveError && (
          <p role="alert" className="mt-2 text-nc-bad">
            {saveError}
          </p>
        )}
      </Panel>
      <Panel
        span={6}
        icon={FolderOpen}
        title="行情数据配置"
        note="目录只读。保存后用于新的行情请求，已加载快照保留原始来源；行情页手动选择优先。全市场覆盖由右上角扫描更新。"
      >
        <Field label="通达信安装目录">
          <Input
            {...fieldProps("tdxRoot")}
            value={config.tdxRoot}
            onChange={(e) => setConfig({ ...config, tdxRoot: e.target.value })}
          />
        </Field>
        {fieldError("tdxRoot")}
        <Field label="默认行情数据源">
          <MarketSourceSelect
            value={config.marketDataSource}
            onChange={(marketDataSource) =>
              setConfig({ ...config, marketDataSource })
            }
          />
        </Field>
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
      </Panel>
      <ConnectionDiagnostics value={draftState.base} dirty={dirty} />
      <StatsPanel
        icon={Database}
        title="本地行情覆盖"
        tag="只读接入"
        meta={
          coverage
            ? `最近扫描 ${stamp(coverage.scannedAt)} · ${coverage.total} 个 A 股周期记录（扫描时间不代表行情时点）`
            : "尚未扫描，保存目录后点击页面右上角扫描。"
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
      <Panel span={6} icon={FolderOpen} title="新闻配置">
        <p className="mb-3 text-nc-text-3">
          新闻 AI 批次：
          {budget.data
            ? `${budget.data.used}/${budget.data.limit} · ${budget.data.day}`
            : "暂未获取"}
          {budget.error ? " · 获取失败" : ""}
          {budget.data?.exhausted ? " · 额度已用完，自动研究暂停至次日" : ""}
        </p>
        <Field label="财联社新闻数据库路径">
          <Input
            {...fieldProps("clsDbPath")}
            value={config.clsDbPath}
            onChange={(e) =>
              setConfig({ ...config, clsDbPath: e.target.value })
            }
          />
        </Field>
        {fieldError("clsDbPath")}
        <Field label="新闻自动研究">
          <span className="flex items-center gap-2 text-[12px] text-nc-text-2">
            <Checkbox
              checked={config.autoNewsAnalysis}
              onCheckedChange={(checked) =>
                setConfig({ ...config, autoNewsAnalysis: checked === true })
              }
            />
            自动分析最近七天新闻（每分钟最多50条，使用当前模型；失败后等待15分钟）
          </span>
        </Field>
        <Field label="自动新闻每日AI批次上限（北京时间）">
          <Input
            {...fieldProps("autoNewsDailyBatches")}
            type="number"
            min={1}
            max={100}
            value={config.autoNewsDailyBatches}
            onChange={(e) =>
              setConfig({
                ...config,
                autoNewsDailyBatches: Number(e.target.value),
              })
            }
          />
          <small className="text-nc-text-4">
            每批最多25条，含最多一次格式修复重试；缓存复用不计，失败计入额度，次日恢复。不是套餐Token余额。
          </small>
        </Field>
        {fieldError("autoNewsDailyBatches")}
        <p className="nc-panel-note">
          通达信目录与外部 Blocks 目录只读；修改后使用页面顶部“保存设置”。
        </p>
      </Panel>
      <Panel
        span={6}
        icon={Sparkle}
        title="研究模型"
        note="Codex / Claude Code 复用本机 CLI 的订阅登录，使用对应套餐额度。请先在终端登录，再启动应用。失败不会自动切换 DeepSeek。"
      >
        <div className="form-grid">
          <Field label="模型提供方">
            <Select
              value={config.llmProvider}
              onValueChange={(value) =>
                setConfig({
                  ...config,
                  llmProvider: value as Settings["llmProvider"],
                })
              }
            >
              <SelectTrigger aria-label="模型提供方" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="codex">Codex（默认 · 本机订阅）</SelectItem>
                <SelectItem value="claude">Claude Code（本机订阅）</SelectItem>
                <SelectItem value="deepseek">DeepSeek（API）</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {config.llmProvider === "deepseek" ? (
            <>
              <Field label="轻量模型">
                <Input
                  value={config.fastModel}
                  onChange={(e) =>
                    setConfig({ ...config, fastModel: e.target.value })
                  }
                />
              </Field>
              <Field label="深度模型">
                <Input
                  value={config.deepModel}
                  onChange={(e) =>
                    setConfig({ ...config, deepModel: e.target.value })
                  }
                />
              </Field>
              <p className="muted">
                使用 DEEPSEEK_API_KEY 环境变量；仅选择此提供方时调用 API。
              </p>
            </>
          ) : (
            <Field label="CLI 模型（留空使用默认模型）">
              <Input
                {...fieldProps(
                  config.llmProvider === "codex" ? "codexModel" : "claudeModel",
                )}
                maxLength={100}
                value={
                  config.llmProvider === "codex"
                    ? config.codexModel
                    : config.claudeModel
                }
                placeholder="使用 CLI 默认模型"
                onChange={(e) =>
                  setConfig({
                    ...config,
                    [config.llmProvider === "codex"
                      ? "codexModel"
                      : "claudeModel"]: e.target.value,
                  })
                }
              />
              {fieldError(
                config.llmProvider === "codex" ? "codexModel" : "claudeModel",
              )}
            </Field>
          )}
          <Field label="自动分析候选数（1–10）">
            <Input
              {...fieldProps("analysisLimit")}
              type="number"
              min={1}
              max={10}
              value={config.analysisLimit}
              onChange={(e) =>
                setConfig({ ...config, analysisLimit: Number(e.target.value) })
              }
            />
          </Field>
          {fieldError("analysisLimit")}
        </div>
        <div className="check-row">
          <label>
            <Checkbox
              checked={config.autoAnalysis}
              onCheckedChange={(checked) =>
                setConfig({ ...config, autoAnalysis: checked === true })
              }
            />
            选股和回测完成后自动分析
          </label>
        </div>
        <Field label="聊天渠道出站代理（可选）">
          <Input
            value={config.proxy}
            onChange={(e) => setConfig({ ...config, proxy: e.target.value })}
            placeholder="http://127.0.0.1:7890"
          />
        </Field>
      </Panel>
      <Panel title="通知策略" icon={PaperPlaneTilt}>
        {fieldError("notificationPolicy")}
        <NotificationPolicyFields
          value={config.notificationPolicy}
          onChange={(notificationPolicy) =>
            setConfig({ ...config, notificationPolicy })
          }
        />
      </Panel>
      <Panel
        icon={PaperPlaneTilt}
        title="聊天推送渠道"
        note="单向通知，无需公网回调地址。保存不会发送消息；点击“发送测试通知”才会向所选目标发送测试内容。"
      >
        {channels.map((c) => (
          <div className="list-row" key={c.id}>
            <div>
              <div className="flex items-center gap-2">
                <ChatCircle size={16} className="text-nc-accent" />
                <strong>{c.name}</strong>
                <Pill tone={c.enabled ? "ok" : "idle"}>
                  {c.enabled ? "已启用" : "已暂停"}
                </Pill>
              </div>
              <p>{c.type} · 凭证已加密保存</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditId(c.id);
                setChannel({
                  name: c.name,
                  type: c.type,
                  target: c.target,
                  thread: c.thread,
                  enabled: c.enabled,
                  secret: "",
                  signingSecret: "",
                });
              }}
            >
              编辑
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => test.mutate(c.id)}
            >
              发送测试通知
            </Button>
          </div>
        ))}
        <h4>{editId ? "编辑渠道" : "添加渠道"}</h4>
        <div className="form-grid">
          <Field label="渠道名称">
            <Input
              value={channel.name}
              onChange={(e) => setChannel({ ...channel, name: e.target.value })}
            />
          </Field>
          <Field label="平台">
            <Select
              value={channel.type}
              onValueChange={(value) =>
                setChannel({
                  ...channel,
                  type: value as Channel["type"],
                })
              }
            >
              <SelectTrigger aria-label="平台" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feishu">飞书群机器人</SelectItem>
                <SelectItem value="wecom">企业微信群机器人</SelectItem>
                <SelectItem value="telegram">Telegram Bot</SelectItem>
                <SelectItem value="discord">Discord Webhook</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={
              channel.type === "telegram" ? "Bot Token" : "机器人 Webhook 地址"
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={channel.secret}
              onChange={(e) =>
                setChannel({ ...channel, secret: e.target.value })
              }
              placeholder={
                editId ? "留空保留已有凭证" : "凭证仅保存到系统加密存储"
              }
            />
          </Field>
          {channel.type === "feishu" && (
            <Field label="签名密钥（可选）">
              <Input
                type="password"
                value={channel.signingSecret}
                onChange={(e) =>
                  setChannel({ ...channel, signingSecret: e.target.value })
                }
              />
            </Field>
          )}
          {channel.type === "telegram" && (
            <Field label="Chat ID（私聊需先联系机器人）">
              <Input
                value={channel.target}
                onChange={(e) =>
                  setChannel({ ...channel, target: e.target.value })
                }
              />
            </Field>
          )}
          {["telegram", "discord"].includes(channel.type) && (
            <Field label="话题 / Thread ID（可选）">
              <Input
                value={channel.thread}
                onChange={(e) =>
                  setChannel({ ...channel, thread: e.target.value })
                }
              />
            </Field>
          )}
        </div>
        <div className="check-row">
          <label>
            <Checkbox
              checked={channel.enabled}
              onCheckedChange={(checked) =>
                setChannel({ ...channel, enabled: checked === true })
              }
            />
            启用此渠道接收订阅信号
          </label>
        </div>
        <div className="button-row">
          <Button
            onClick={() =>
              saveChannel.mutate({
                ...channel,
                id: editId,
                secret: channel.secret || undefined,
              })
            }
            disabled={saveChannel.isPending}
          >
            <Plus size={14} />
            保存渠道
          </Button>
          {editId && (
            <Button
              variant="ghost"
              onClick={() => {
                setEditId(undefined);
                setChannel({
                  name: "",
                  type: "feishu",
                  target: "",
                  thread: "",
                  secret: "",
                  signingSecret: "",
                  enabled: false,
                });
              }}
            >
              取消编辑
            </Button>
          )}
        </div>
      </Panel>
      <CryptoConnections />
      <Panel
        icon={Books}
        title="研究技能"
        meta={`已登记 ${skillCatalog.data?.length ?? 0} 项`}
        note="自动快评按量价方法每批分析最多 5 只。其他已登记技能会在对应研究模块接入后开放，登记不代表已执行完整流程。"
      >
        <details className="my-0">
          <summary>
            查看技能登记与版本（{skillCatalog.data?.length ?? 0}）
          </summary>
          {skillCatalog.error && <p>{skillCatalog.error.message}</p>}
          <div className="mt-2 max-h-80 overflow-auto">
            {skillCatalog.data?.map((skill) => (
              <div className="list-row" key={skill.skillId}>
                <div>
                  <strong>{skill.skillId}</strong>
                  <small className="block text-nc-text-4">
                    {skill.ruleVersion ?? "流程待接入"} ·{" "}
                    {skill.hash?.slice(0, 16) ?? "未找到文件"}
                  </small>
                  <small className="block text-nc-text-4">
                    {skill.integrationScope}
                  </small>
                  <small className="block text-nc-text-4">
                    前提：{skill.prerequisites.join("；")}
                  </small>
                  <small className="block text-nc-text-4">
                    调用预算：{skill.budget}
                  </small>
                  {skill.missingFiles.length > 0 && (
                    <small className="block text-nc-warn">
                      缺少文件：{skill.missingFiles.join("、")}
                    </small>
                  )}
                </div>
                <Pill
                  tone={
                    skill.status === "incomplete"
                      ? "warn"
                      : skill.installed
                        ? "accent"
                        : "idle"
                  }
                >
                  {skill.status === "quick-review"
                    ? "量价快评"
                    : skill.status === "staged-research"
                      ? "分阶段研究"
                      : skill.status === "adapter"
                        ? "部分数据接入"
                        : skill.status === "incomplete"
                          ? "依赖不完整"
                          : skill.installed
                            ? "已登记"
                            : "未安装"}
                </Pill>
              </div>
            ))}
          </div>
        </details>
      </Panel>
    </PageGrid>
  );
}
