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
import { Database, Send, Sparkles, Workflow } from "lucide-react";
import { useState } from "react";
import { type Channel, type Settings } from "~/lib/domain";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";

import { Field, stamp } from "./shared";
import { NotificationPolicyFields } from "../notification-policy-fields";

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
    [editId, setEditId] = useState<string | undefined>(),
    [tools, setTools] = useState<
      { name: string; description?: string; schema: unknown }[]
    >([]),
    [toolName, setToolName] = useState(""),
    [args, setArgs] = useState("{}"),
    [mcpResult, setMcpResult] = useState("");
  const mcpHealth = api.mcpHealth.useQuery(undefined, { staleTime: 30000 });
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
    }),
    importMcp = api.importMcp.useMutation({
      onSuccess: () => {
        notify("本机 MCP 配置已导入加密存储");
        void utils.status.invalidate();
      },
      onError,
    }),
    listTools = api.mcpTools.useMutation({
      onSettled: () => {
        void utils.mcpHealth.invalidate();
      },
      onSuccess: (t) => {
        setTools(t);
        notify(`已发现 ${t.length} 个允许使用的数据工具`);
      },
      onError,
    }),
    query = api.mcpQuery.useMutation({
      onSuccess: (r) => setMcpResult(JSON.stringify(r, null, 2)),
      onError,
    });
  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <Sparkles size={18} />
          <h3>研究技能</h3>
        </div>
        <p>
          自动快评按量价方法每批分析最多 5
          只。其他已登记技能会在对应研究模块接入后开放，登记不代表已执行完整流程。
        </p>
        <details>
          <summary>
            查看技能登记与版本（{skillCatalog.data?.length ?? 0}）
          </summary>
          {skillCatalog.error && <p>{skillCatalog.error.message}</p>}
          <div className="max-h-80 overflow-auto">
            {skillCatalog.data?.map((skill) => (
              <div className="list-row" key={skill.skillId}>
                <div>
                  <strong>{skill.skillId}</strong>
                  <small>
                    {skill.ruleVersion ?? "流程待接入"} ·{" "}
                    {skill.hash?.slice(0, 16) ?? "未找到文件"}
                  </small>
                  <small>{skill.integrationScope}</small>
                  <small>前提：{skill.prerequisites.join("；")}</small>
                  <small>调用预算：{skill.budget}</small>
                  {skill.missingFiles.length > 0 && (
                    <small>缺少文件：{skill.missingFiles.join("、")}</small>
                  )}
                </div>
                <span className="tag">
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
                </span>
              </div>
            ))}
          </div>
        </details>
      </section>
      <section className="panel">
        <div className="panel-title">
          <Database size={18} />
          <h3>本地行情</h3>
          <span className="tag">只读接入</span>
        </div>
        <Field label="财联社新闻数据库路径">
          <Input
            value={config.clsDbPath}
            onChange={(e) =>
              setConfig({ ...config, clsDbPath: e.target.value })
            }
          />
        </Field>
        <Field label="新闻自动研究">
          <span>
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
          <small>
            每批最多25条，含最多一次格式修复重试；缓存复用不计，失败计入额度，次日恢复。不是套餐Token余额。
          </small>
          {budget.data && (
            <small>
              {budget.data.day} 已用 {budget.data.used}/{budget.data.limit} 批 ·{" "}
              {budget.data.exhausted
                ? "额度已用完，自动研究暂停至次日"
                : "额度可用"}
            </small>
          )}
        </Field>
        <div className="coverage-grid">
          {Object.entries(coverage?.counts ?? {}).map(([name, count]) => (
            <div key={name}>
              <span>{name.replace("day", "日线").replace("5m", "五分钟")}</span>
              <strong>{count.toLocaleString()}</strong>
              <small>行情文件</small>
            </div>
          ))}
        </div>
        <p className="muted">
          {coverage
            ? `最近扫描 ${stamp(coverage.scannedAt)} · ${coverage.total} 个 A 股周期记录`
            : "尚未扫描，保存目录后点击页面右上角扫描。"}
        </p>
      </section>
      <section className="panel">
        <div className="panel-title">
          <Sparkles size={18} />
          <h3>研究模型</h3>
        </div>
        <p className="muted">
          Codex / Claude Code 复用本机 CLI
          的订阅登录，使用对应套餐额度。请先在终端登录，再启动应用。失败不会自动切换
          DeepSeek。
        </p>
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
        <Button onClick={() => save.mutate(config)} disabled={save.isPending}>
          保存设置
        </Button>
      </section>
      <section className="panel">
        <div className="panel-title">
          <Workflow size={18} />
          <h3>通达信 MCP</h3>
        </div>
        <p>
          从本机 Codex 配置导入服务地址与认证，使用 Node.js
          直接连接。认证过期后更新本机配置并重新导入。
        </p>
        <div className="button-row">
          <Button
            variant="outline"
            onClick={() => importMcp.mutate()}
            disabled={importMcp.isPending}
          >
            导入本机配置
          </Button>
          <Button
            variant="outline"
            onClick={() => listTools.mutate()}
            disabled={listTools.isPending}
          >
            检测连接与工具
          </Button>
        </div>
        <p className="muted">
          {mcpHealth.data
            ? `最近检测：${mcpHealth.data.status === "available" ? "工具发现成功" : "检测失败"} · ${stamp(mcpHealth.data.checkedAt)} · ${mcpHealth.data.latencyMs} ms`
            : "尚未检测服务。已导入配置不代表连接可用。"}
        </p>
        {mcpHealth.data && (
          <details>
            <summary>连接检测记录与工具版本</summary>
            <p>{mcpHealth.data.message}</p>
            <p>
              最近成功：
              {mcpHealth.data.lastSuccessAt
                ? stamp(mcpHealth.data.lastSuccessAt)
                : "无"}
            </p>
            <p>
              与上次成功检测相比：新增{" "}
              {mcpHealth.data.changes.added.join("、") || "无"}；移除{" "}
              {mcpHealth.data.changes.removed.join("、") || "无"}；结构变化{" "}
              {mcpHealth.data.changes.changed.join("、") || "无"}。
            </p>
            <pre>
              {mcpHealth.data.tools
                .map((tool) => `${tool.name}: ${tool.schemaHash}`)
                .join("\n")}
            </pre>
          </details>
        )}
        {tools.length > 0 && (
          <details>
            <summary>数据工具查询</summary>
            <Select
              value={toolName}
              onValueChange={(selected) => setToolName(selected)}
            >
              <SelectTrigger aria-label="数据工具" className="w-full">
                <SelectValue placeholder="选择工具" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">选择工具</SelectItem>
                {tools.map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <pre>
              {JSON.stringify(
                tools.find((t) => t.name === toolName)?.schema,
                null,
                2,
              )}
            </pre>
            <Field label="查询参数 JSON">
              <Textarea
                className="field-sizing-fixed"
                rows={5}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </Field>
            <Button
              onClick={() => {
                try {
                  query.mutate({
                    name: toolName,
                    args: JSON.parse(args) as Record<string, unknown>,
                  });
                } catch {
                  notify("参数必须是合法 JSON");
                }
              }}
            >
              查询
            </Button>
            <pre>{mcpResult}</pre>
          </details>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <Send size={18} />
          <h3>聊天推送渠道</h3>
        </div>
        {channels.map((c) => (
          <div className="list-row" key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <p>
                {c.type} · {c.enabled ? "已启用" : "已暂停"} · 凭证已加密保存
              </p>
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
        </div>
        <Field
          label={
            channel.type === "telegram" ? "Bot Token" : "机器人 Webhook 地址"
          }
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={channel.secret}
            onChange={(e) => setChannel({ ...channel, secret: e.target.value })}
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
        <p className="muted">
          单向通知，无需公网回调地址。保存不会发送消息；点击“发送测试通知”才会向所选目标发送测试内容。
        </p>
      </section>
    </>
  );
}
