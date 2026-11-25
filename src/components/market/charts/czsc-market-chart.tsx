"use client";
import { useEffect, useMemo, useState } from "react";
import { capabilityAllows } from "~/lib/common/capabilities";
import { api } from "~/trpc/react";
import type { Bar } from "~/lib/domain";
import type { ChartAdjustment } from "~/lib/chart/chart-adjustment";
import type {
  ChartView,
  Drawing,
  ChartPeriod as Period,
} from "~/lib/chart/chart-view";
import type { ChartCompare } from "../market-chart-state";
import type { CrosshairLink } from "~/lib/chart/crosshair-link";
import type { RpsCurve } from "~/lib/chart/chart-data";
import type { IntelEvent } from "~/lib/news/intel-events";
import { useScreenVisible } from "../../workbench/use-task-visible";
import { useCzscSettings } from "~/lib/stores/czsc-settings-store";
import { czscEffectiveSettings } from "~/lib/chart/czsc-settings";
import {
  breakoutAnalysisOptionsFromSettings,
  breakoutFilterFromSettings,
} from "~/lib/chart/overlay-settings";
import { useOverlaySettings } from "~/lib/stores/overlay-settings-store";
import { MarketChart, type ChartAnnotationVisibility } from "./market-chart";

export function CzscMarketChart({
  pricePrecision = 2,
  volumeUnit,
  bars,
  period,
  snapshotId,
  adjustment = "none",
  chartSnapshot = false,
  view,
  onViewChange,
  drawingTool,
  drawingPoints,
  drawingText,
  compare,
  onAnchor,
  cost,
  rps,
  rpsMessage,
  onRpsRetry,
  onHistoryRequest,
  viewportKey,
  annotations = true,
  rpsAvailable = true,
  hotkeys = false,
  link,
  height,
  sharedDrawings,
  newsEvents,
  onNewsEvent,
}: {
  newsEvents?: readonly IntelEvent[];
  onNewsEvent?: (id: string) => void;
  bars: Bar[];
  period: Period;
  snapshotId: string;
  hotkeys?: boolean;
  /** Crosshair shared with the other periods of this symbol. */
  link?: { hub: CrosshairLink; id: string };
  /** Fixed canvas height (a secondary chart); default fills the window. */
  height?: number;
  /** Drawings shared from the symbol's other periods, already remapped. */
  sharedDrawings?: Drawing[];
  /** RPS is an A-share ranking; futures, crypto and sectors hide it. */
  rpsAvailable?: boolean;
  /** Chan/breakout overlays; off for charts outside the A-share method scope. */
  annotations?: boolean;
  adjustment?: ChartAdjustment;
  chartSnapshot?: boolean;
  pricePrecision?: number;
  volumeUnit?: string;
  view?: ChartView;
  onViewChange?: (view: ChartView) => void;
  drawingTool?: Drawing["kind"] | "none";
  /** Comparison symbols (TDX 叠加): drawn on a shared percentage scale. */
  compare?: readonly ChartCompare[];
  /** Anchors placed so far for the active drawing tool. */
  drawingPoints?: readonly Drawing["a"][];
  /** Label for the text tool preview. */
  drawingText?: string;
  onAnchor?: (p: Drawing["a"]) => void;
  cost?: number | null;
  rps?: RpsCurve;
  rpsMessage?: string;
  onRpsRetry?: () => void;
  onHistoryRequest?: () => void;
  viewportKey?: string;
}) {
  const [annotationVisibility, setAnnotationVisibility] =
    useState<ChartAnnotationVisibility>({
      breakout: true,
      czsc: true,
      patterns: false,
    });
  const [paintedSnapshot, setPaintedSnapshot] = useState("");
  useEffect(() => {
    // Let the mounted price chart paint before starting annotation requests.
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setPaintedSnapshot(snapshotId));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [snapshotId]);
  // A hidden kept-alive panel defers the structure analysis until shown.
  const visible = useScreenVisible();
  const annotationsReady = visible && paintedSnapshot === snapshotId;
  const {
    values: czscValues,
    showStroke,
    showSegment,
    showSegmentCenters,
    showSegmentSignals,
  } = useCzscSettings();
  const breakoutSettings = useOverlaySettings((state) => state.breakout);
  const patternSettings = useOverlaySettings((state) => state.patternBreakout);
  const breakoutFilter = useMemo(
    () => breakoutFilterFromSettings(breakoutSettings),
    [breakoutSettings],
  );
  // The schema's dependency rules fix or drop inapplicable fields before the
  // DLL sees them, so a stale combination never fails the whole overlay.
  const czscSchema = api.czscSchema.useQuery(undefined, {
    enabled: visible && annotations && annotationVisibility.czsc,
    staleTime: Infinity,
    retry: false,
  });
  const result = api.czsc.useQuery(
    {
      snapshotId,
      chartSnapshot,
      settings: czscEffectiveSettings(czscSchema.data, czscValues),
    },
    {
      enabled: annotationsReady && annotations && annotationVisibility.czsc,
      staleTime: Infinity,
      retry: false,
    },
  );
  // Level toggles only filter what is drawn; structure settings went to the query.
  const czscView = useMemo(
    () =>
      result.data && {
        ...result.data,
        families: result.data.families.flatMap((family) => {
          if (family.config === 0) return showStroke ? [family] : [];
          if (!showSegment && !showSegmentCenters && !showSegmentSignals)
            return [];
          return [
            {
              ...family,
              points: showSegment ? family.points : [],
              centers: showSegmentCenters ? family.centers : [],
              signals: showSegmentSignals ? family.signals : [],
            },
          ];
        }),
      },
    [
      result.data,
      showStroke,
      showSegment,
      showSegmentCenters,
      showSegmentSignals,
    ],
  );
  const breakout = api.breakout.useQuery(
    {
      snapshotId,
      chartSnapshot,
      options: breakoutAnalysisOptionsFromSettings(breakoutSettings),
    },
    {
      enabled:
        annotationsReady &&
        annotations &&
        annotationVisibility.breakout &&
        capabilityAllows("breakout", "compute"),
      staleTime: Infinity,
      retry: false,
    },
  );
  const patternBreakout = api.patternBreakout.useQuery(
    {
      snapshotId,
      chartSnapshot,
      options: {
        kinds: patternSettings.kinds,
        direction: patternSettings.direction,
        minVolumeRatio: patternSettings.minVolumeRatio,
        minScore: patternSettings.minScore,
      },
    },
    {
      enabled:
        annotationsReady &&
        annotations &&
        Boolean(annotationVisibility.patterns) &&
        capabilityAllows("breakout", "compute"),
      staleTime: Infinity,
      retry: false,
    },
  );
  return (
    <MarketChart
      newsEvents={newsEvents}
      onNewsEvent={onNewsEvent}
      pricePrecision={pricePrecision}
      volumeUnit={volumeUnit}
      bars={bars}
      period={period}
      adjustment={adjustment}
      view={view}
      onViewChange={onViewChange}
      drawingTool={drawingTool}
      drawingPoints={drawingPoints}
      drawingText={drawingText}
      compare={compare}
      onAnchor={onAnchor}
      cost={cost}
      rps={rps}
      rpsMessage={rpsMessage}
      onRpsRetry={onRpsRetry}
      onHistoryRequest={onHistoryRequest}
      viewportKey={viewportKey}
      annotations={annotations}
      rpsAvailable={rpsAvailable}
      hotkeys={hotkeys}
      link={link}
      height={height}
      sharedDrawings={sharedDrawings}
      annotationVisibility={annotationVisibility}
      onAnnotationVisibilityChange={setAnnotationVisibility}
      czsc={annotations && annotationVisibility.czsc ? czscView : undefined}
      breakout={
        annotations && annotationVisibility.breakout ? breakout.data : undefined
      }
      breakoutFilter={breakoutFilter}
      breakoutMessage={
        !annotationsReady || !annotations || !annotationVisibility.breakout
          ? undefined
          : breakout.error
            ? `双突破计算失败：${breakout.error.message}`
            : breakout.isPending
              ? "双突破标注后台加载中，K 线可正常浏览"
              : undefined
      }
      patternBreakout={
        annotations && annotationVisibility.patterns
          ? patternBreakout.data
          : undefined
      }
      showAllPatternGeometry={patternSettings.showAllGeometry}
      patternBreakoutMessage={
        !annotationsReady || !annotations || !annotationVisibility.patterns
          ? undefined
          : patternBreakout.error
            ? `形态突破计算失败：${patternBreakout.error.message}`
            : patternBreakout.isPending
              ? "形态突破标注后台加载中，K 线可正常浏览"
              : undefined
      }
      czscMessage={
        !annotationsReady || !annotations || !annotationVisibility.czsc
          ? undefined
          : result.error
            ? `缠论计算失败：${result.error.message}`
            : result.isPending
              ? "缠论标注后台加载中，K 线可正常浏览"
              : undefined
      }
    />
  );
}
