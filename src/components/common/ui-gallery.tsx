"use client";

import { useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { DataTable, type DataTableColumn } from "~/components/ui/data-table";

type Sample = { id: string; name: string; status: string };
const first: Sample = { id: "sh600519", name: "贵州茅台", status: "待复核" };
const second: Sample = { id: "sz000001", name: "平安银行", status: "已记录" };
const third: Sample = { id: "sz000002", name: "万科 A", status: "待复核" };
// Canned server responses: never sort or slice an all-market array in the client.
const pages = {
  asc: [[first, second], [third]],
  desc: [[third, second], [first]],
};
const columns: DataTableColumn<Sample>[] = [
  { accessorKey: "id", header: "证券代码", sortDescFirst: false },
  { accessorKey: "name", header: "名称", enableSorting: false },
  {
    accessorKey: "status",
    header: "状态",
    enableSorting: false,
    cell: ({ row }) => <Badge variant="secondary">{row.original.status}</Badge>,
  },
];
const empty: Sample[] = [];

export default function UiGallery() {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 2,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "id", desc: false },
  ]);
  const [mode, setMode] = useState("ready");
  const [notice, setNotice] = useState("请选择一个菜单操作。");
  const data =
    pages[sorting[0]?.desc ? "desc" : "asc"][pagination.pageIndex] ?? empty;
  return (
    <TooltipProvider>
      <main className="min-w-0 space-y-6 p-4 md:p-6">
        <header className="space-y-2">
          <a href="/">← 返回工作台</a>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">UI组件参考</h1>
            <Badge variant="outline">设计示例</Badge>
          </div>
          <p className="text-muted-foreground">
            对照表单、表格与浮层的交互状态。所有内容均为本地展示样例，不连接行情、账本或通知。
          </p>
        </header>
        <Alert>
          <AlertTitle>浅色与阅读规范</AlertTitle>
          <AlertDescription>
            正文14px、辅助文字13px、表格行高44px。页面与图表采用浅色，可通过Tab查看焦点，以Esc关闭浮层。
          </AlertDescription>
        </Alert>
        <nav
          aria-label="组件目录"
          className="sticky top-0 z-10 flex flex-wrap gap-3 rounded-lg border bg-card p-3 text-sm"
        >
          <a href="#gallery-form">表单</a>
          <a href="#gallery-feedback">状态与操作</a>
          <a href="#gallery-overlays">对话框与菜单</a>
          <a href="#gallery-content">内容组织</a>
          <a href="#gallery-table">分页与数据状态</a>
        </nav>
        <div className="grid gap-6 md:grid-cols-2">
          <Card id="gallery-form" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>表单 · Input / Textarea / Label</CardTitle>
              <CardDescription>默认、占位、禁用与错误提示</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="sample-name">观察名称</Label>
                <Input id="sample-name" placeholder="例如：日线观察" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sample-note">备注</Label>
                <Textarea id="sample-note" placeholder="记录需要复核的事实" />
              </div>
              <Input aria-label="禁用输入" disabled value="只读展示样例" />
              <div className="space-y-2">
                <Label htmlFor="sample-error">必填项</Label>
                <Input
                  id="sample-error"
                  aria-invalid="true"
                  aria-describedby="sample-error-note"
                />
                <span
                  id="sample-error-note"
                  className="text-sm text-destructive"
                >
                  请输入观察名称。
                </span>
              </div>
              <Label htmlFor="sample-period">周期 · Select</Label>
              <Select defaultValue="day">
                <SelectTrigger id="sample-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">日线</SelectItem>
                  <SelectItem value="week">周线</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-3">
                <Checkbox id="sample-check" defaultChecked />
                <Label htmlFor="sample-check">加入展示列表 · Checkbox</Label>
              </div>
              <div className="flex items-center gap-3">
                <Switch id="sample-switch" />
                <Label htmlFor="sample-switch">显示辅助说明 · Switch</Label>
              </div>
            </CardContent>
          </Card>
          <Card id="gallery-feedback" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>状态与操作 · Card / Badge / Alert</CardTitle>
              <CardDescription>
                白底内容、蓝色操作；状态同时显示文字
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-wrap gap-2">
                <Badge>已记录</Badge>
                <Badge variant="secondary">待复核</Badge>
                <Badge variant="outline">仅观察</Badge>
                <Badge variant="destructive">读取失败</Badge>
              </div>
              <Alert variant="destructive">
                <AlertTitle>样例加载失败</AlertTitle>
                <AlertDescription>
                  这是错误状态展示，可以在下方表格尝试重试。
                </AlertDescription>
              </Alert>
              <Separator />
              <div className="flex flex-wrap gap-2">
                <Button>既有主按钮</Button>
                <Button variant="outline">次要操作</Button>
                <Button variant="ghost">文字操作</Button>
                <Button variant="danger">危险操作</Button>
                <Button disabled>禁用</Button>
              </div>
              <div className="space-y-2">
                <Label>加载占位 · Skeleton</Label>
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-5 w-1/2" />
              </div>
              <Collapsible defaultOpen>
                <CollapsibleTrigger asChild>
                  <Button variant="outline">
                    展开 / 收起说明 · Collapsible
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <p>折叠内容仅展示，不保存设置。</p>
                </CollapsibleContent>
              </Collapsible>
            </CardContent>
          </Card>
          <Card id="gallery-overlays" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>浮层 · Dialog / DropdownMenu / Tooltip</CardTitle>
              <CardDescription>可用键盘打开，以 Escape 关闭</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">打开对话框</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>复核展示内容</DialogTitle>
                    <DialogDescription>
                      此操作仅供查看浮层的配色、边距和文字，不会修改业务数据。
                    </DialogDescription>
                  </DialogHeader>
                  <Label htmlFor="dialog-note">展示备注</Label>
                  <Input id="dialog-note" placeholder="可用 Tab 切换焦点" />
                </DialogContent>
              </Dialog>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">打开菜单</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    onSelect={() => setNotice("已选择查看样例。")}
                  >
                    查看样例
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled>暂不可用</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline">查看提示</Button>
                </TooltipTrigger>
                <TooltipContent>提示文字应清晰可读。</TooltipContent>
              </Tooltip>
              <span
                role="status"
                className="w-full text-sm text-muted-foreground"
              >
                {notice}
              </span>
            </CardContent>
          </Card>
          <Card id="gallery-content" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>内容组织 · Tabs / ScrollArea / Separator</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="notes">
                <TabsList>
                  <TabsTrigger value="notes">观察说明</TabsTrigger>
                  <TabsTrigger value="boundary">使用边界</TabsTrigger>
                </TabsList>
                <TabsContent value="notes">
                  <ScrollArea
                    className="h-36 rounded-md border border-border p-3"
                    tabIndex={0}
                    aria-label="观察说明滚动区域"
                  >
                    {Array.from({ length: 8 }, (_, i) => (
                      <div key={i}>
                        <p>观察 {i + 1}：先记录事实，再复核数据来源。</p>
                        <Separator />
                      </div>
                    ))}
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="boundary">
                  <p>样例不是投资建议，也不代表策略业绩。</p>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
        <Card id="gallery-table" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>分页表格 · Table / DataTable</CardTitle>
            <CardDescription>
              点击证券代码切换排序，翻页接收另一份预置响应；每次只展示当前页。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger aria-label="表格展示状态">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ready">正常</SelectItem>
                <SelectItem value="loading">加载中</SelectItem>
                <SelectItem value="empty">空数据</SelectItem>
                <SelectItem value="error">加载失败</SelectItem>
              </SelectContent>
            </Select>
            <DataTable
              columns={columns}
              data={mode === "empty" ? empty : data}
              rowCount={mode === "empty" ? 0 : 3}
              pagination={
                mode === "empty" ? { ...pagination, pageIndex: 0 } : pagination
              }
              sorting={sorting}
              onPaginationChange={setPagination}
              onSortingChange={(updater) => {
                setSorting(updater);
                setPagination((current) => ({ ...current, pageIndex: 0 }));
              }}
              getRowId={(row) => row.id}
              label="分页展示样例"
              loading={mode === "loading"}
              error={mode === "error" ? "样例读取失败，请重试。" : undefined}
              onRetry={() => setMode("ready")}
            />
          </CardContent>
        </Card>
        <p className="text-[13px] text-muted-foreground">
          窄窗中控件按行排列，宽表只在表格内部横向滚动；对话框关闭后焦点返回触发按钮。
        </p>
      </main>
    </TooltipProvider>
  );
}
