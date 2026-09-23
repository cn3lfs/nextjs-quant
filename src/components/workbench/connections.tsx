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
import { useState } from "react";
import { type Channel, type Settings } from "~/lib/domain";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";

import { Field, stamp } from "./shared";
import { NotificationPolicyFields } from "../signals/notification-policy-fields";

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
  const budget = api.newsBudget.useQuery(undefined, { refetchInterval: 30000 });
  const skillCatalog = api.researchSkills.useQuery(undefined, {
    staleTime: 60000,
  });
  const directory = api.securityNames.useQuery(undefined, {
    staleTime: 60000,
    refetchInterval: 300000,
  });
  const names = directory.data ?? {};
  const utils = api.useUtils(),
    [config, setConfig] = useState(value),
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
      onSuccess: () => {
        notify("设置已保存");
        void utils.status.invalidate();
        void utils.securityProfile.invalidate();
        void utils.securityNames.invalidate();
        void utils.securities.invalidate();
      },
      onError,
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
  return (
    <PageGrid>
      <StatsPanel
        icon={Database}
        title="本地行情"
        tag="只读接入"
        meta={
          coverage
            ? `最近扫描 ${stamp(coverage.scannedAt)} · ${coverage.total} 个 A 股周期记录`
            : "尚未扫描，保存目录后点击页面右上角扫描。"
        }
        items={[
          ...Object.entries(coverage?.counts ?? {}).map(([name, count]) => ({
            key: name,
            label: name.replace("day", "日线").replace("5m", "五分钟"),
            value: count.toLocaleString(),
            note: "行情文件",
          })),
          {
            key: "news-budget",
            label: "新闻 AI 批次",
            value: budget.data
              ? `${budget.data.used}/${budget.data.limit}`
              : "—",
            note: budget.data
              ? `${budget.data.day} · ${budget.data.exhausted ? "额度已用完，自动研究暂停至次日" : "额度可用"}`
              : "今日已用",
            tone: budget.data?.exhausted ? "warn" : "neutral",
          },
        ]}
      />
      <Panel span={6} icon={FolderOpen} title="路径与新闻">
        <Field label="财联社新闻数据库路径">
          <Input
            value={config.clsDbPath}
            onChange={(e) =>
              setConfig({ ...config, clsDbPath: e.target.value })
            }
          />
        </Field>
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
        <Field label="通达信安装目录">
          <Input
            value={config.tdxRoot}
            onChange={(e) => setConfig({ ...config, tdxRoot: e.target.value })}
          />
        </Field>
        <Field label="自动新闻每日AI批次上限（北京时间）">
          <Input
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
        <p className="nc-panel-note">
          通达信目录与外部 Blocks 目录只读；设置在“研究模型”面板底部统一保存。
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
            </Field>
          )}
          <Field label="自动分析候选数（1–10）">
            <Input
              type="number"
              min={1}
              max={10}
              value={config.analysisLimit}
              onChange={(e) =>
                setConfig({ ...config, analysisLimit: Number(e.target.value) })
              }
            />
          </Field>
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
        <details>
          <summary>交易日历覆盖</summary>
          <p>
            默认读取本地上证指数日线中的交易日期。若需覆盖，输入已确认的交易日期，每行一个；空白表示使用默认来源。
          </p>
          <Textarea
            className="field-sizing-fixed"
            rows={4}
            value={config.calendar.join("\n")}
            onChange={(e) =>
              setConfig({
                ...config,
                calendar: e.target.value.split(/\s+/).filter(Boolean),
              })
            }
          />
        </details>
        <NotificationPolicyFields
          value={config.notificationPolicy}
          onChange={(notificationPolicy) =>
            setConfig({ ...config, notificationPolicy })
          }
        />
        <Field label="默认行情数据源">
          <MarketSourceSelect
            value={config.marketDataSource}
            onChange={(marketDataSource) =>
              setConfig({ ...config, marketDataSource })
            }
          />
        </Field>
        <Button onClick={() => save.mutate(config)} disabled={save.isPending}>
          <FloppyDisk size={14} />
          保存设置
        </Button>
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
