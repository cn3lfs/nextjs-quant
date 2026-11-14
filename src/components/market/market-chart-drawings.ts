import { chartColor } from "~/lib/chart/chart-theme";
import {
  type attachDrawings,
  drawingAnchor,
  drawingX,
  hitDrawing,
  drawingPreview,
  type DrawingHandle,
} from "~/lib/chart/chart-drawings";
import type { Drawing } from "~/lib/chart/chart-view";
import type {
  MarketChartState,
  ChartInstanceOptions,
} from "./market-chart-state";

/** The chart owns its primitives; this disposer owns the drawing DOM listeners. */
export function attachDrawingInteractions(
  state: MarketChartState,
  container: HTMLDivElement,
  {
    period,
    live,
    setSelected,
  }: Pick<ChartInstanceOptions, "period" | "live" | "setSelected">,
  updatePreview: ReturnType<typeof attachDrawings>,
) {
  const { chart, candles, setDrawings } = state;
  const drawingContainer = container;
  const anchorAt = (event: MouseEvent) => {
    const bounds = drawingContainer.getBoundingClientRect();
    const x = event.clientX - bounds.left,
      y = event.clientY - bounds.top;
    if (
      x < 0 ||
      x > chart.timeScale().width() ||
      y < 0 ||
      y > chart.panes()[0]!.getHeight()
    )
      return null;
    return drawingAnchor(chart, candles, state.bars, period, x, y);
  };
  // Chart crosshair events quantize x to a bar even in Normal mode.
  // Native coordinates preserve the actual pointer location between bars.
  const moveDrawing = (event: MouseEvent) => {
    const {
      drawingTool: tool,
      drawingPoints: from,
      drawingText,
    } = live.current;
    if (tool === "none") return;
    updatePreview(
      drawingPreview(
        tool,
        from ?? [],
        anchorAt(event),
        chartColor.accentLight,
        drawingText,
      ),
    );
  };
  const clickDrawing = (event: MouseEvent) => {
    const { drawingTool: tool, onAnchor: anchor } = live.current;
    if (!anchor || tool === "none" || event.button !== 0) return;
    const point = anchorAt(event);
    if (point) {
      updatePreview(null);
      anchor(point);
    }
  };
  const clearPreview = () => updatePreview(null);
  drawingContainer.addEventListener("mousemove", moveDrawing);
  drawingContainer.addEventListener("click", clickDrawing);
  drawingContainer.addEventListener("mouseleave", clearPreview);
  // Browsing (no tool): pointing at a saved drawing selects it; dragging a
  // handle reshapes it, dragging the body moves it. Anchors are recomputed
  // from the moved pixels so they stay on real bars and prices.
  let edit: {
    id: string;
    handle: DrawingHandle | null;
    x: number;
    y: number;
    original: Drawing;
    next: Drawing | null;
  } | null = null;
  const local = (event: MouseEvent) => {
    const bounds = drawingContainer.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const shift = (p: Drawing["a"], dx: number, dy: number) => {
    const x = drawingX(chart, p, period),
      y = candles.priceToCoordinate(p.price);
    return x === null || y === null
      ? null
      : drawingAnchor(chart, candles, state.bars, period, x + dx, y + dy);
  };
  const reshape = (
    d: Drawing,
    handle: DrawingHandle | null,
    dx: number,
    dy: number,
  ): Drawing | null => {
    const keys: DrawingHandle[] =
      handle && d.kind !== "horizontal"
        ? [handle]
        : (["a", "b", "c"] as const).filter((k) => d[k]);
    const next: Drawing = { ...d };
    for (const key of keys) {
      const moved = shift(d[key]!, dx, dy);
      if (!moved) return null;
      next[key] = moved;
    }
    return next;
  };
  const beginEdit = (event: PointerEvent) => {
    const {
      drawingTool: tool,
      view: current,
      onViewChange: save,
    } = live.current;
    if (tool !== "none" || event.button !== 0 || !current || !save) return;
    const p = local(event);
    if (p.y > chart.panes()[0]!.getHeight()) return;
    const hit = hitDrawing(setDrawings.geometries(), p.x, p.y);
    setSelected(hit?.id ?? null);
    const original = hit && current.drawings.find((d) => d.id === hit.id);
    if (!hit || !original) return;
    edit = { id: hit.id, handle: hit.handle, ...p, original, next: null };
    // Keep the chart from panning under the drag.
    chart.applyOptions({
      handleScroll: { pressedMouseMove: false },
      handleScale: { axisPressedMouseMove: false },
    });
    event.stopPropagation();
  };
  const blockPan = (event: MouseEvent) => {
    if (edit) event.stopPropagation();
  };
  const moveEdit = (event: PointerEvent) => {
    if (!edit) return;
    const p = local(event);
    const next = reshape(
      edit.original,
      edit.handle,
      p.x - edit.x,
      p.y - edit.y,
    );
    const current = live.current.view;
    if (!next || !current) return;
    edit.next = next;
    setDrawings(
      current.drawings.map((d) => (d.id === next.id ? next : d)),
      next.id,
    );
  };
  const endEdit = () => {
    if (!edit) return;
    const { next } = edit;
    edit = null;
    const {
      view: current,
      onViewChange: save,
      drawingTool: tool,
    } = live.current;
    chart.applyOptions({
      handleScroll: { pressedMouseMove: tool === "none" },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: !current?.subchart.includes("rps"),
        },
      },
    });
    if (next && current && save)
      save({
        ...current,
        drawings: current.drawings.map((d) => (d.id === next.id ? next : d)),
      });
  };
  drawingContainer.addEventListener("pointerdown", beginEdit, true);
  drawingContainer.addEventListener("mousedown", blockPan, true);
  window.addEventListener("pointermove", moveEdit);
  window.addEventListener("pointerup", endEdit);

  return () => {
    drawingContainer.removeEventListener("mousemove", moveDrawing);
    drawingContainer.removeEventListener("click", clickDrawing);
    drawingContainer.removeEventListener("mouseleave", clearPreview);
    drawingContainer.removeEventListener("pointerdown", beginEdit, true);
    drawingContainer.removeEventListener("mousedown", blockPan, true);
    window.removeEventListener("pointermove", moveEdit);
    window.removeEventListener("pointerup", endEdit);
  };
}
