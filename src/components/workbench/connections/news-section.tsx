import { FolderOpen } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel } from "../../panels";
import { Input } from "../../ui/input";
import { Checkbox } from "../../ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../ui/select";
import type { Settings } from "~/lib/domain";
import { Field } from "../shared";
import { NewsSourceDiagnostics } from "../news-source-diagnostics";
import type { FieldError, FieldProps, NewsBudget } from "./shared";

export function NewsSection({
  config,
  setConfig,
  fieldProps,
  fieldError,
  value,
  dirty,
  savePending,
  budget,
}: {
  config: Settings;
  setConfig: (draft: Settings) => void;
  fieldProps: FieldProps;
  fieldError: FieldError;
  value: Settings;
  dirty: boolean;
  savePending: boolean;
  budget: NewsBudget;
}) {
  return (
    <PageGrid>
      <Panel span={12} icon={FolderOpen} title="新闻配置">
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
        <p className="mb-3 text-[13px] text-nc-text-3">
          填写已有新闻数据库的绝对路径；留空表示尚未接入，不会自动创建数据库。主档案继续承接模型分析、日任务和图表情报。
        </p>
        <Field label="主档案类型">
          <Select
            value={config.clsDbRole}
            onValueChange={(value) =>
              setConfig({
                ...config,
                clsDbRole: value as Settings["clsDbRole"],
              })
            }
          >
            <SelectTrigger {...fieldProps("clsDbRole")} aria-label="主档案类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unspecified">未注明</SelectItem>
              <SelectItem value="all">全部电报</SelectItem>
              <SelectItem value="red">加红电报</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {fieldError("clsDbRole")}
        <p className="mb-3 text-[13px] text-nc-text-3">
          由你声明该档案的类型；未注明不会按路径、level 或 bold
          字段自动识别。新闻页只在已声明类型之间切换。
        </p>
        <Field label="互补新闻档案路径">
          <Input
            {...fieldProps("clsComplementDbPath")}
            value={config.clsComplementDbPath}
            onChange={(e) =>
              setConfig({ ...config, clsComplementDbPath: e.target.value })
            }
          />
        </Field>
        {fieldError("clsComplementDbPath")}
        <Field label="互补档案类型">
          <Select
            value={config.clsComplementDbRole || "unset"}
            onValueChange={(value) =>
              setConfig({
                ...config,
                clsComplementDbRole:
                  value === "unset" ? "" : (value as "all" | "red"),
              })
            }
          >
            <SelectTrigger
              {...fieldProps("clsComplementDbRole")}
              aria-label="互补档案类型"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">未配置</SelectItem>
              <SelectItem value="all">全部电报</SelectItem>
              <SelectItem value="red">加红电报</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {fieldError("clsComplementDbRole")}
        <p className="mb-3 text-[13px] text-nc-text-3">
          互补档案仅用于新闻页阅读和打开原文，不参与模型分析、日任务或图表情报。两个档案不能声明同一类型，也不能指向同一路径；指向同一真实文件时新闻页只显示一个来源。
        </p>
        <Field label="新闻 Python 可执行文件">
          <Input
            {...fieldProps("newsPythonExecutable")}
            value={config.newsPythonExecutable}
            onChange={(e) =>
              setConfig({ ...config, newsPythonExecutable: e.target.value })
            }
            placeholder="python 或 Python 可执行文件的完整路径"
          />
        </Field>
        {fieldError("newsPythonExecutable")}
        <p className="mb-3 text-[13px] text-nc-text-3">
          用于新闻技能脚本批次，普通新闻阅读无需 Python。默认从 PATH 查找
          python；填写完整路径时无需加引号。
        </p>
        <NewsSourceDiagnostics value={value} dirty={dirty || savePending} />
        <Field label="新闻自动研究">
          <span className="flex items-center gap-2 text-[13px] text-nc-text-2">
            <Checkbox
              checked={config.autoNewsAnalysis}
              onCheckedChange={(checked) =>
                setConfig({
                  ...config,
                  autoNewsAnalysis: checked === true,
                })
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
          行情读取与外部 Blocks 目录只读。修改后使用页面顶部“保存设置”。
        </p>
      </Panel>
    </PageGrid>
  );
}
