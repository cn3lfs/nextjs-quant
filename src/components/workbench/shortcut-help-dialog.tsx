"use client";
import { Keyboard } from "@phosphor-icons/react/ssr";
import { useWorkbenchUiStore } from "~/lib/stores/workbench-ui-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";

const shortcutGroups = [
  {
    label: "全局",
    rows: [
      ["Ctrl K / Ctrl Shift P", "打开命令面板"],
      ["?", "打开快捷键帮助"],
      ["Esc", "关闭最上层浮层；无浮层时退出专注模式"],
      ["Ctrl B", "收起 / 展开侧栏"],
      ["Shift F", "开启 / 退出专注模式"],
      ["Alt 1…7", "跳转到第 1–7 个工作区"],
    ],
  },
  {
    label: "命令面板",
    rows: [
      ["↑ / ↓", "在结果间移动"],
      ["Enter", "打开当前页面、动作或标的"],
      ["Shift Enter", "本机标的打开财务视图"],
      [">", "只搜索快捷动作"],
      ["@", "只搜索本机标的"],
    ],
  },
  {
    label: "列表与图表",
    rows: [
      ["F5", "分时 ↔ 上次 K 线周期（图表焦点内）"],
      ["F8", "周期循环（图表焦点内）"],
      ["↑ / ↓", "在列表中移动当前行"],
      ["Enter", "打开当前项"],
    ],
  },
] as const;

export function ShortcutHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const singleKeyShortcuts = useWorkbenchUiStore(
    (state) => state.singleKeyShortcuts,
  );
  const setSingleKeyShortcuts = useWorkbenchUiStore(
    (state) => state.setSingleKeyShortcuts,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="lg:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard size={18} aria-hidden="true" />
            快捷键速查
          </DialogTitle>
          <DialogDescription>
            输入框、文本域与中文输入法组合态下不触发单键快捷键；组合键始终可用。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {shortcutGroups.map((group) => (
            <section key={group.label}>
              <h3 className="mb-1 text-sm font-semibold">{group.label}</h3>
              <dl className="m-0 grid gap-1">
                {group.rows.map(([keys, description]) => (
                  <div
                    key={keys}
                    className="flex items-baseline justify-between gap-4 border-b border-nc-border-soft py-1.5 last:border-b-0"
                  >
                    <dt>
                      <kbd className="rounded border border-nc-border bg-nc-inset px-1.5 py-0.5 text-[11px] text-nc-text-2">
                        {keys}
                      </kbd>
                    </dt>
                    <dd className="m-0 text-right text-sm text-nc-text-3">
                      {description}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border border-nc-border-soft p-3">
          <div>
            <p className="m-0 text-sm">启用单键快捷键</p>
            <p className="m-0 text-xs text-nc-text-4">
              关闭后「?」不再打开本帮助；Ctrl / Alt / Shift 组合键不受影响。
            </p>
          </div>
          <Switch
            checked={singleKeyShortcuts}
            onCheckedChange={setSingleKeyShortcuts}
            aria-label="启用单键快捷键"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
