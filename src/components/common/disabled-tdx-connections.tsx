// Retained for quota restoration; deliberately not imported by the application UI.
import { useState } from "react";
import { Workflow } from "lucide-react";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Field, stamp } from "../workbench/shared";
export function DisabledTdxConnections({
  notify,
}: {
  notify: (s: string) => void;
}) {
  const utils = api.useUtils();
  const [tools, setTools] = useState<
    { name: string; description?: string; schema: unknown }[]
  >([]);
  const [toolName, setToolName] = useState("");
  const [args, setArgs] = useState("{}");
  const [mcpResult, setMcpResult] = useState("");
  const mcpHealth = api.mcpHealth.useQuery(undefined, { staleTime: 30000 });
  const onError = (e: { message: string }) => notify(e.message);
  const importMcp = api.importMcp.useMutation({
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
    <section className="panel">
      <div className="panel-title">
        <Workflow size={18} />
        <h3>通达信 MCP</h3>
      </div>
      <p>
        从本机 Codex 配置导入服务地址与认证文件路径，使用 Node.js
        直接连接。认证在每次连接时现读该文件，本机刷新后无需重新导入；仅服务地址或文件路径变化时才需再导入一次。
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
  );
}
