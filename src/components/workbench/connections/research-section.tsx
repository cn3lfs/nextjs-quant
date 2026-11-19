import { Books, Sparkle } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, Pill } from "../../panels";
import { Input } from "../../ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../ui/select";
import type { Settings } from "~/lib/domain";
import { Field } from "../shared";
import type { FieldError, FieldProps, SkillCatalog } from "./shared";

export function ResearchSection({
  config,
  setConfig,
  fieldProps,
  fieldError,
  skillCatalog,
}: {
  config: Settings;
  setConfig: (draft: Settings) => void;
  fieldProps: FieldProps;
  fieldError: FieldError;
  skillCatalog: SkillCatalog;
}) {
  return (
    <PageGrid>
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
        </div>
        <Field label="聊天渠道出站代理（可选）">
          <Input
            value={config.proxy}
            onChange={(e) => setConfig({ ...config, proxy: e.target.value })}
            placeholder="http://127.0.0.1:7890"
          />
        </Field>
      </Panel>
      <Panel
        icon={Books}
        title="研究技能"
        meta={`已登记 ${skillCatalog.data?.length ?? 0} 项`}
        note="已登记技能在对应研究模块中使用；登记不代表已执行完整流程。"
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
