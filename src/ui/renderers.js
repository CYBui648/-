import { STAGES, STAGE_ORDER } from "../config/system-config.js";
import { dom } from "./dom.js";

function getStageStatusLabel(status) {
  return {
    locked: "未解锁",
    ready: "待运行",
    running: "运行中",
    done: "已完成",
    error: "出错"
  }[status] || status;
}

function getUnlockedSummary(state) {
  return STAGE_ORDER
    .filter((key) => state.stages[key].status !== "locked")
    .map((key) => STAGES[key].title)
    .join(" / ");
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return (value * 100).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

const MONTH_LABELS = [
  "1月", "2月", "3月", "4月", "5月", "6月",
  "7月", "8月", "9月", "10月", "11月", "12月"
];

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function resetAnnualChart(container, emptyText = "暂无数据") {
  if (!container) return;
  container.innerHTML = `<div class="annual-chart-empty">${emptyText}</div>`;
}

function resetInsightChart(container, emptyText = "暂无数据") {
  if (!container) return;
  container.innerHTML = `<div class="insight-chart-empty">${emptyText}</div>`;
}

function toAverageDaySeries(series, pointsPerDay = 96) {
  if (!Array.isArray(series) || series.length === 0) return [];

  const sums = Array(pointsPerDay).fill(0);
  const counts = Array(pointsPerDay).fill(0);

  series.forEach((value, index) => {
    const bucket = index % pointsPerDay;
    const n = Number(value || 0);
    sums[bucket] += n;
    counts[bucket] += 1;
  });

  return sums.map((sum, index) => counts[index] ? sum / counts[index] : 0);
}

function svgPolyline(values, xScale, yScale) {
  return values
    .map((value, index) => `${xScale(index)},${yScale(value)}`)
    .join(" ");
}

function downsampleSeries(values, maxPoints = 180) {
  if (!Array.isArray(values) || values.length <= maxPoints) return values || [];

  const step = Math.ceil(values.length / maxPoints);
  const sampled = [];

  for (let i = 0; i < values.length; i += step) {
    const chunk = values.slice(i, i + step).map((value) => Number(value || 0));
    const avg = chunk.reduce((sum, value) => sum + value, 0) / Math.max(1, chunk.length);
    sampled.push(avg);
  }

  return sampled;
}

function sliceSeriesWindow(values, startIndex, endIndex) {
  if (!Array.isArray(values) || values.length === 0) return [];
  return values.slice(startIndex, Math.max(startIndex + 2, endIndex));
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function clampWindowRange(startPct, endPct, minSpanPct) {
  let nextStart = Number.isFinite(startPct) ? startPct : 0;
  let nextEnd = Number.isFinite(endPct) ? endPct : 100;

  if (nextEnd - nextStart < minSpanPct) nextEnd = nextStart + minSpanPct;
  nextStart = Math.max(0, Math.min(100 - minSpanPct, nextStart));
  nextEnd = Math.max(nextStart + minSpanPct, Math.min(100, nextEnd));

  if (nextEnd > 100) {
    const span = Math.max(minSpanPct, nextEnd - nextStart);
    nextEnd = 100;
    nextStart = Math.max(0, nextEnd - span);
  }

  return { start: nextStart, end: nextEnd, span: nextEnd - nextStart };
}

function formatProfileTimeLabel(dayValue, totalDays) {
  const clampedDay = Math.max(0, Math.min(Math.max(0, totalDays - 0.001), dayValue));
  const dayIndex = Math.floor(clampedDay);
  const hour = Math.floor((clampedDay - dayIndex) * 24);
  const minute = Math.round((((clampedDay - dayIndex) * 24) - hour) * 60);
  const timeLabel = `${hour}:${String(minute).padStart(2, "0")}`;

  if (totalDays <= 7) {
    const dayLabel = WEEKDAY_LABELS[Math.min(WEEKDAY_LABELS.length - 1, dayIndex)] || `D${dayIndex + 1}`;
    return totalDays <= 2 ? `${dayLabel} ${timeLabel}` : dayLabel;
  }

  return totalDays <= 3 ? `D${dayIndex + 1} ${timeLabel}` : `D${dayIndex + 1}`;
}

function buildProfileTicks(startPct, endPct, totalDays, tickCount = 6) {
  const spanPct = Math.max(0.001, endPct - startPct);
  const count = Math.max(2, tickCount);

  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    const dayValue = ((startPct + spanPct * ratio) / 100) * totalDays;
    return {
      ratio,
      label: formatProfileTimeLabel(dayValue, totalDays)
    };
  });
}

function profileWindowTransform(startPct, endPct, left, plotWidth) {
  const spanPct = Math.max(0.001, endPct - startPct);
  const scaleX = 100 / spanPct;
  const selectedStartX = left + (startPct / 100) * plotWidth;
  const translateX = left - selectedStartX * scaleX;
  return `matrix(${scaleX} 0 0 1 ${translateX} 0)`;
}

function renderSeriesProfileChart(container, series, options = {}) {
  if (!container || !series) {
    resetInsightChart(container, options.emptyText || "暂无功率曲线数据。");
    return;
  }

  const loadRaw = Array.isArray(series.load) ? series.load.map((v) => Number(v || 0)) : [];
  const pvRaw = Array.isArray(series.pv) ? series.pv.map((v) => Number(v || 0)) : [];
  const gridRaw = Array.isArray(series.grid) ? series.grid.map((v) => Number(v || 0)) : [];
  const socRaw = Array.isArray(series.soc) ? series.soc.map((v) => Number(v || 0)) : [];
  const rawPointCount = Math.max(loadRaw.length, pvRaw.length, gridRaw.length, socRaw.length, 2);
  const savedStart = Number(container.dataset.windowStart || 0);
  const savedEnd = Number(container.dataset.windowEnd || 100);
  const timelineDays = options.timelineDays || Math.max(1, rawPointCount / 96);
  const minWindowPct = Math.max(100 / Math.max(1, timelineDays), 3);
  let windowStartPct = Number.isFinite(options.windowStartPct) ? options.windowStartPct : savedStart;
  let windowEndPct = Number.isFinite(options.windowEndPct) ? options.windowEndPct : (savedEnd || 100);
  const initialWindow = clampWindowRange(windowStartPct, windowEndPct, minWindowPct);
  windowStartPct = initialWindow.start;
  windowEndPct = initialWindow.end;
  container.dataset.windowStart = String(windowStartPct);
  container.dataset.windowEnd = String(windowEndPct);

  const maxPoints = options.maxPoints || Math.min(rawPointCount, 1600);
  const load = downsampleSeries(loadRaw, maxPoints);
  const pv = downsampleSeries(pvRaw, maxPoints);
  const grid = downsampleSeries(gridRaw, maxPoints);
  const soc = downsampleSeries(socRaw, maxPoints);

  if (!load.length && !pv.length && !grid.length && !soc.length) {
    resetInsightChart(container, options.emptyText || "暂无功率曲线数据。");
    return;
  }

  const pointCount = Math.max(load.length, pv.length, grid.length, soc.length, 2);
  const visibleDays = timelineDays * ((windowEndPct - windowStartPct) / 100);
  const width = 960;
  const height = 440;
  const left = 68;
  const right = 68;
  const top = 38;
  const bottom = 58;
  const plotWidth = width - left - right;
  const socBandHeight = 68;
  const socGap = 22;
  const powerPlotHeight = height - top - bottom - socGap - socBandHeight;
  const socTop = top + powerPlotHeight + socGap;
  const chartBottom = socTop + socBandHeight;
  const clipId = `profile-clip-${Math.random().toString(36).slice(2)}`;
  const powerMax = Math.max(...load, ...pv, ...grid, Number(options.limitKw || 0), 1);
  const socMax = 100;

  const xScale = (index) => left + (index / Math.max(1, pointCount - 1)) * plotWidth;
  const yPower = (value) => top + powerPlotHeight - (Math.max(0, value) / powerMax) * powerPlotHeight;
  const ySoc = (value) => socTop + socBandHeight - (Math.max(0, Math.min(socMax, value)) / socMax) * socBandHeight;
  const limitY = yPower(Number(options.limitKw || 0));

  const ticks = options.tickBuilder
    ? options.tickBuilder(windowStartPct, windowEndPct, timelineDays)
    : buildProfileTicks(windowStartPct, windowEndPct, timelineDays);

  const axisTicks = ticks.map((tick, index) => {
    const x = left + tick.ratio * plotWidth;
    return `
      <line class="profile-grid" x1="${x}" y1="${top}" x2="${x}" y2="${chartBottom}" />
      <text class="profile-axis-label profile-time-tick" data-profile-tick="${index}" x="${x}" y="${height - 22}">${tick.label}</text>
    `;
  }).join("");

  const overviewWidth = 960;
  const overviewHeight = 76;
  const overviewLeft = 24;
  const overviewRight = 24;
  const overviewTop = 12;
  const overviewBottom = 18;
  const overviewPlotWidth = overviewWidth - overviewLeft - overviewRight;
  const overviewPlotHeight = overviewHeight - overviewTop - overviewBottom;
  const overviewSeries = downsampleSeries(loadRaw.length ? loadRaw : pvRaw, 360);
  const overviewMax = Math.max(...overviewSeries, 1);
  const overviewX = (index) => overviewLeft + (index / Math.max(1, overviewSeries.length - 1)) * overviewPlotWidth;
  const overviewY = (value) => overviewTop + overviewPlotHeight - (Math.max(0, value) / overviewMax) * overviewPlotHeight;
  const selectionX = overviewLeft + (windowStartPct / 100) * overviewPlotWidth;
  const selectionWidth = ((windowEndPct - windowStartPct) / 100) * overviewPlotWidth;
  const initialTransform = profileWindowTransform(windowStartPct, windowEndPct, left, plotWidth);

  container.innerHTML = `
    <div class="profile-toolbar">
      <div>
        <strong>${options.title || "功率曲线"}</strong>
        <span>${options.subtitle || "拖动底部视窗查看不同时间段"}</span>
      </div>
      <div class="profile-actions">
        <button type="button" data-profile-zoom="reset">全局</button>
        <em data-profile-window-label>${formatNumber(visibleDays, 1)} 天</em>
      </div>
    </div>
    <div class="profile-main-chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="功率画像" data-profile-main-svg data-profile-width="${width}" data-profile-height="${height}">
        <defs>
          <clipPath id="${clipId}">
            <rect x="${left}" y="${top - 6}" width="${plotWidth}" height="${chartBottom - top + 12}" />
          </clipPath>
        </defs>
        <line class="profile-axis" x1="${left}" y1="${top}" x2="${left}" y2="${top + powerPlotHeight}" />
        <line class="profile-axis" x1="${left}" y1="${top + powerPlotHeight}" x2="${left + plotWidth}" y2="${top + powerPlotHeight}" />
        <rect class="profile-soc-band" x="${left}" y="${socTop}" width="${plotWidth}" height="${socBandHeight}" />
        <line class="profile-axis" x1="${left}" y1="${socTop}" x2="${left}" y2="${chartBottom}" />
        <line class="profile-axis" x1="${left}" y1="${chartBottom}" x2="${left + plotWidth}" y2="${chartBottom}" />
        ${axisTicks}
        <line class="profile-grid" x1="${left}" y1="${top}" x2="${left + plotWidth}" y2="${top}" />
        <line class="profile-grid" x1="${left}" y1="${top + powerPlotHeight / 2}" x2="${left + plotWidth}" y2="${top + powerPlotHeight / 2}" />
        <line class="profile-grid" x1="${left}" y1="${socTop + socBandHeight / 2}" x2="${left + plotWidth}" y2="${socTop + socBandHeight / 2}" />
        <text class="profile-axis-label" x="8" y="${top + 4}">${formatNumber(powerMax, 0)} kW</text>
        <text class="profile-axis-label" x="18" y="${top + powerPlotHeight + 4}">0</text>
        <text class="profile-axis-label profile-soc-label" x="${width - 60}" y="${socTop + 4}">SOC 100%</text>
        <text class="profile-axis-label profile-soc-label" x="${width - 36}" y="${chartBottom + 4}">0%</text>
        ${options.limitKw ? `
          <line class="profile-limit" x1="${left}" y1="${limitY}" x2="${left + plotWidth}" y2="${limitY}" />
          <text class="profile-limit-label" x="${left + plotWidth - 86}" y="${limitY - 6}">变压器红线</text>
        ` : ""}
        <g clip-path="url(#${clipId})">
          <g data-profile-series-layer transform="${initialTransform}">
            ${pv.length ? `<polyline class="profile-line pv" vector-effect="non-scaling-stroke" points="${svgPolyline(pv, xScale, yPower)}" />` : ""}
            ${grid.length ? `<polyline class="profile-line grid" vector-effect="non-scaling-stroke" points="${svgPolyline(grid, xScale, yPower)}" />` : ""}
            ${load.length ? `<polyline class="profile-line load" vector-effect="non-scaling-stroke" points="${svgPolyline(load, xScale, yPower)}" />` : ""}
            ${soc.length ? `<polyline class="profile-line soc" vector-effect="non-scaling-stroke" points="${svgPolyline(soc, xScale, ySoc)}" />` : ""}
          </g>
        </g>
      </svg>
    </div>
    <div class="profile-navigator">
      <svg viewBox="0 0 ${overviewWidth} ${overviewHeight}" role="img" aria-label="全局预览">
        <polyline class="profile-overview-line" points="${svgPolyline(overviewSeries, overviewX, overviewY)}" />
        <rect class="profile-overview-mask left" x="${overviewLeft}" y="${overviewTop}" width="${Math.max(0, selectionX - overviewLeft)}" height="${overviewPlotHeight}" />
        <rect class="profile-overview-mask right" x="${selectionX + selectionWidth}" y="${overviewTop}" width="${Math.max(0, overviewLeft + overviewPlotWidth - selectionX - selectionWidth)}" height="${overviewPlotHeight}" />
        <rect class="profile-overview-window" x="${selectionX}" y="${overviewTop}" width="${selectionWidth}" height="${overviewPlotHeight}" />
        <line class="profile-overview-handle" x1="${selectionX}" y1="${overviewTop - 4}" x2="${selectionX}" y2="${overviewTop + overviewPlotHeight + 4}" />
        <line class="profile-overview-handle" x1="${selectionX + selectionWidth}" y1="${overviewTop - 4}" x2="${selectionX + selectionWidth}" y2="${overviewTop + overviewPlotHeight + 4}" />
      </svg>
      <div class="profile-range-controls">
        <label>
          <span>窗口</span>
          <input type="range" min="0" max="${Math.max(0, 100 - (windowEndPct - windowStartPct))}" step="0.1" value="${windowStartPct}" data-profile-pan>
        </label>
      </div>
    </div>
    <div class="profile-legend">
      <span><i class="legend-line load"></i>充电负荷</span>
      <span><i class="legend-line pv"></i>光伏出力</span>
      ${grid.length ? '<span><i class="legend-line grid"></i>购电功率</span>' : ""}
      <span><i class="legend-line soc"></i>储能 SOC</span>
      ${options.limitKw ? '<span><i class="legend-line limit"></i>变压器红线</span>' : ""}
    </div>
  `;

  const updateWindow = (nextStart, nextEnd) => {
    const nextWindow = clampWindowRange(nextStart, nextEnd, minWindowPct);
    const span = nextWindow.span;
    container.dataset.windowStart = String(nextWindow.start);
    container.dataset.windowEnd = String(nextWindow.end);
    container.querySelector("[data-profile-series-layer]")?.setAttribute(
      "transform",
      profileWindowTransform(nextWindow.start, nextWindow.end, left, plotWidth)
    );
    const windowLabel = container.querySelector("[data-profile-window-label]");
    if (windowLabel) {
      windowLabel.textContent = `${formatNumber(timelineDays * (span / 100), 1)} 天`;
    }
    updateAxisTicks(nextWindow.start, nextWindow.end);
    updateNavigatorWindow(nextWindow.start, nextWindow.end);

    if (panControl) {
      panControl.max = String(Math.max(0, 100 - span));
      panControl.value = String(nextWindow.start);
    }
  };

  container.querySelectorAll("[data-profile-zoom='reset']").forEach((button) => {
    button.addEventListener("click", () => {
      updateWindow(0, 100);
    });
  });

  const panControl = container.querySelector("[data-profile-pan]");
  let panFrame = 0;
  let pendingPanStart = windowStartPct;
  const updateAxisTicks = (nextStart, nextEnd) => {
    const nextTicks = options.tickBuilder
      ? options.tickBuilder(nextStart, nextEnd, timelineDays)
      : buildProfileTicks(nextStart, nextEnd, timelineDays);

    nextTicks.forEach((tick, index) => {
      const tickText = container.querySelector(`[data-profile-tick="${index}"]`);
      if (!tickText) return;
      tickText.setAttribute("x", String(left + tick.ratio * plotWidth));
      tickText.textContent = tick.label;
    });
  };

  const updateNavigatorWindow = (nextStart, nextEnd) => {
    const nextSelectionX = overviewLeft + (nextStart / 100) * overviewPlotWidth;
    const nextSelectionWidth = ((nextEnd - nextStart) / 100) * overviewPlotWidth;
    const leftMask = container.querySelector(".profile-overview-mask.left");
    const rightMask = container.querySelector(".profile-overview-mask.right");
    const windowRect = container.querySelector(".profile-overview-window");
    const handles = container.querySelectorAll(".profile-overview-handle");

    leftMask?.setAttribute("width", String(Math.max(0, nextSelectionX - overviewLeft)));
    rightMask?.setAttribute("x", String(nextSelectionX + nextSelectionWidth));
    rightMask?.setAttribute("width", String(Math.max(0, overviewLeft + overviewPlotWidth - nextSelectionX - nextSelectionWidth)));
    windowRect?.setAttribute("x", String(nextSelectionX));
    windowRect?.setAttribute("width", String(nextSelectionWidth));
    handles[0]?.setAttribute("x1", String(nextSelectionX));
    handles[0]?.setAttribute("x2", String(nextSelectionX));
    handles[1]?.setAttribute("x1", String(nextSelectionX + nextSelectionWidth));
    handles[1]?.setAttribute("x2", String(nextSelectionX + nextSelectionWidth));
  };

  panControl?.addEventListener("input", () => {
    const currentStart = Number(container.dataset.windowStart || windowStartPct);
    const currentEnd = Number(container.dataset.windowEnd || windowEndPct);
    const span = currentEnd - currentStart;
    pendingPanStart = Number(panControl.value || 0);
    if (panFrame) return;
    panFrame = requestAnimationFrame(() => {
      panFrame = 0;
      updateWindow(pendingPanStart, pendingPanStart + span);
    });
  });

  const navigatorSvg = container.querySelector(".profile-navigator svg");
  let activePanDrag = null;

  const pctFromNavigatorEvent = (event) => {
    const rect = navigatorSvg?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const plotRatio = Math.max(0, Math.min(1, (ratio * overviewWidth - overviewLeft) / overviewPlotWidth));
    return plotRatio * 100;
  };

  navigatorSvg?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    navigatorSvg.setPointerCapture(event.pointerId);
    const currentStart = Number(container.dataset.windowStart || windowStartPct);
    const currentEnd = Number(container.dataset.windowEnd || windowEndPct);
    const span = currentEnd - currentStart;
    const pointerPct = pctFromNavigatorEvent(event);
    const offsetPct = pointerPct >= currentStart && pointerPct <= currentEnd
      ? pointerPct - currentStart
      : span / 2;

    activePanDrag = { span, offsetPct };
    pendingPanStart = Math.max(0, Math.min(100 - span, pointerPct - offsetPct));
    updateWindow(pendingPanStart, pendingPanStart + span);
  });

  navigatorSvg?.addEventListener("pointermove", (event) => {
    if (!activePanDrag) return;
    const dragSpan = activePanDrag.span;
    pendingPanStart = Math.max(
      0,
      Math.min(100 - dragSpan, pctFromNavigatorEvent(event) - activePanDrag.offsetPct)
    );
    if (panFrame) return;
    panFrame = requestAnimationFrame(() => {
      panFrame = 0;
      updateWindow(pendingPanStart, pendingPanStart + dragSpan);
    });
  });

  const endNavigatorDrag = (event) => {
    if (!activePanDrag) return;
    activePanDrag = null;
    navigatorSvg.releasePointerCapture?.(event.pointerId);
  };

  navigatorSvg?.addEventListener("pointerup", endNavigatorDrag);
  navigatorSvg?.addEventListener("pointercancel", endNavigatorDrag);

  const zoomByWheel = (event) => {
    event.preventDefault();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const cursorRatio = rect.width > 0
      ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      : 0.5;
    const currentStart = Number(container.dataset.windowStart || windowStartPct);
    const currentEnd = Number(container.dataset.windowEnd || windowEndPct);
    const span = currentEnd - currentStart;
    const factor = event.deltaY < 0 ? 0.90 : 1.12;
    const nextSpan = Math.max(minWindowPct, Math.min(100, span * factor));
    const anchor = currentStart + span * cursorRatio;
    const nextStart = Math.max(0, Math.min(100 - nextSpan, anchor - nextSpan * cursorRatio));
    updateWindow(nextStart, nextStart + nextSpan);
  };

  container.querySelector(".profile-main-chart")?.addEventListener("wheel", zoomByWheel, { passive: false });
  container.querySelector(".profile-navigator")?.addEventListener("wheel", zoomByWheel, { passive: false });
}

function renderM1StandardWeekChart(container, chartData) {
  if (!chartData) {
    resetInsightChart(container, "运行 M1 后展示标准周功率模拟。");
    return;
  }

  renderSeriesProfileChart(
    container,
    {
      load: chartData.ev || [],
      pv: chartData.pv || [],
      soc: chartData.soc || []
    },
    {
      emptyText: "运行 M1 后展示标准周功率模拟。",
      ticks: [
        { label: "周一", ratio: 0 },
        { label: "周二", ratio: 1 / 6 },
        { label: "周三", ratio: 2 / 6 },
        { label: "周四", ratio: 3 / 6 },
        { label: "周五", ratio: 4 / 6 },
        { label: "周六", ratio: 5 / 6 },
        { label: "周日", ratio: 1 }
      ],
      timelineDays: 7,
      defaultZoom: 1,
      title: "标准周连续模拟",
      subtitle: "缩小看一周全貌，放大查看日内波动"
    }
  );
}

function pickM2WorstDay(result) {
  const ev = result?.chartData?.ev || [];
  const soc = result?.chartData?.soc || [];
  const queue = result?.chartData?.queue || [];
  const limitKw = Number(result?.summary?.transformerLimitKw || 0);
  const pointsPerDay = 96;
  const days = Math.max(1, Math.floor(ev.length / pointsPerDay));
  let worst = { day: 0, score: -Infinity };

  for (let day = 0; day < days; day++) {
    const start = day * pointsPerDay;
    const dayLoad = ev.slice(start, start + pointsPerDay).map((v) => Number(v || 0));
    const daySoc = soc.slice(start, start + pointsPerDay).map((v) => Number(v || 100));
    const dayQueue = queue.slice(start, start + pointsPerDay).map((v) => Number(v || 0));
    const overflowTicks = limitKw > 0 ? dayLoad.filter((v) => v > limitKw).length : 0;
    const peak = Math.max(...dayLoad, 0);
    const minSoc = Math.min(...daySoc, 100);
    const queuePeak = Math.max(...dayQueue, 0);
    const score =
      overflowTicks * 8 +
      Math.max(0, peak - limitKw) * 0.04 +
      queuePeak * 1.5 +
      Math.max(0, 8 - minSoc) * 5;

    if (score > worst.score) {
      worst = { day, score, overflowTicks, peak, minSoc, queuePeak };
    }
  }

  return worst;
}

function renderM2MonthChart(container, result) {
  const chartData = result?.chartData;
  const ev = chartData?.ev || [];
  if (!chartData || !Array.isArray(ev) || ev.length === 0) {
    resetInsightChart(container, "运行 M2 后展示压力月连续功率曲线。");
    return;
  }

  const pointsPerDay = 96;
  const worst = pickM2WorstDay(result);
  const days = Math.max(1, Math.floor(ev.length / pointsPerDay));

  renderSeriesProfileChart(
    container,
    {
      load: chartData.ev,
      pv: chartData.pv,
      grid: chartData.grid,
      soc: chartData.soc
    },
    {
      limitKw: result.summary?.transformerLimitKw,
      emptyText: "运行 M2 后展示压力月连续功率曲线。",
      timelineDays: days,
      defaultZoom: 1,
      title: `压力月连续曲线（${days} 天）`,
      subtitle: `可缩放查看日内细节；最高风险日：第 ${worst.day + 1} 天`
    }
  );

  container.insertAdjacentHTML("afterbegin", `
    <div class="worst-day-note">
      <strong>最高风险日：第 ${worst.day + 1} 天</strong>
      <span>峰值 ${formatNumber(worst.peak, 1)} kW · 越限 ${worst.overflowTicks || 0} tick · 排队峰值 ${formatNumber(worst.queuePeak || 0, 0)} · 最低 SOC ${formatNumber(worst.minSoc, 1)}%</span>
    </div>
  `);
}

function renderM2MonthEChart(container, result) {
  const chartData = result?.chartData;
  const ev = chartData?.ev || [];
  if (!container || !chartData || !Array.isArray(ev) || ev.length === 0) {
    resetInsightChart(container, "运行 M2 后展示压力月连续功率曲线。");
    return;
  }

  const pointsPerDay = 96;
  const worst = pickM2WorstDay(result);
  const previousChartEl = container.querySelector("[data-m2-month-echart]");
  if (previousChartEl && typeof echarts !== "undefined") {
    const previous = echarts.getInstanceByDom(previousChartEl);
    if (previous) previous.dispose();
  }

  if (typeof echarts === "undefined") {
    resetInsightChart(container, "ECharts 未加载，暂无法展示压力月曲线。");
    return;
  }

  container.innerHTML = `
    <div class="worst-day-note">
      <strong>最高风险日：第 ${worst.day + 1} 天</strong>
      <span>峰值 ${formatNumber(worst.peak, 1)} kW · 越限 ${worst.overflowTicks || 0} tick · 排队峰值 ${formatNumber(worst.queuePeak || 0, 0)} · 最低 SOC ${formatNumber(worst.minSoc, 1)}%</span>
    </div>
    <div class="m2-month-echart" data-m2-month-echart></div>
  `;

  const chartEl = container.querySelector("[data-m2-month-echart]");
  const chart = echarts.init(chartEl);
  const axis = ev.map((_, index) => {
    const day = Math.floor(index / pointsPerDay) + 1;
    const slot = index % pointsPerDay;
    const hour = Math.floor(slot / 4);
    const minute = (slot % 4) * 15;
    return `D${day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  });
  const limitKw = Number(result.summary?.transformerLimitKw || 0);
  const powerValues = [
    ...(chartData.ev || []),
    ...(chartData.pv || []),
    ...(chartData.grid || [])
  ].map((value) => Number(value || 0));
  const curveMaxKw = Math.max(...powerValues, 1);
  const showLimit = Number.isFinite(limitKw) && limitKw > 0 && limitKw <= curveMaxKw * 1.18;
  const powerAxisMax = Math.ceil((Math.max(curveMaxKw, showLimit ? limitKw : 0) * 1.12) / 10) * 10;

  chart.setOption({
    textStyle: { fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' },
    animation: false,
    color: ["#2454d6", "#008f9c", "#7c3aed", "#d97706"],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: "rgba(255, 255, 255, 0.96)",
      borderColor: "#E2E8F0",
      padding: [10, 12],
      textStyle: { color: "#1E293B", fontSize: 12 },
      extraCssText: "box-shadow: 0 12px 24px rgba(15, 23, 42, 0.12); border-radius: 8px;"
    },
    legend: {
      top: 0,
      left: 4,
      icon: "roundRect",
      itemWidth: 16,
      itemHeight: 4,
      itemGap: 14,
      textStyle: { color: "#64748B", fontSize: 12 },
      data: ["充电负荷", "光伏出力", "购电功率", "储能 SOC"]
    },
    grid: { left: 58, right: 58, top: 52, bottom: 58, containLabel: true },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none", throttle: 60 },
      {
        type: "slider",
        xAxisIndex: 0,
        filterMode: "none",
        bottom: 14,
        height: 24,
        borderColor: "rgba(15, 23, 42, 0.12)",
        fillerColor: "rgba(0, 143, 156, 0.14)",
        handleStyle: { color: "#008f9c" },
        textStyle: { color: "#64748B" }
      }
    ],
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: axis,
      axisLabel: { color: "#64748B", hideOverlap: true },
      axisLine: { lineStyle: { color: "#CBD5E1" } },
      axisTick: { show: false }
    },
    yAxis: [
      {
        type: "value",
        name: "kW",
        min: 0,
        max: powerAxisMax,
        nameTextStyle: { color: "#94A3B8" },
        axisLabel: { color: "#64748B" },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: "#EEF2F7", type: "dashed" } }
      },
      {
        type: "value",
        name: "SOC",
        min: 0,
        max: 160,
        nameTextStyle: { color: "#94A3B8" },
        interval: 50,
        axisLabel: {
          color: "#64748B",
          formatter: (value) => value <= 100 && value % 50 === 0 ? `${value}%` : ""
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: "充电负荷",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2.2 },
        areaStyle: { opacity: 0.10 },
        data: chartData.ev || []
      },
      {
        name: "光伏出力",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.08 },
        data: chartData.pv || []
      },
      {
        name: "购电功率",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.8 },
        data: chartData.grid || []
      },
      {
        name: "储能 SOC",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 1,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.8, color: "#d97706", opacity: 0.82 },
        data: chartData.soc || []
      },
      ...(showLimit ? [{
        name: "变压器红线",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: false,
        silent: true,
        lineStyle: { width: 0 },
        data: ev.map(() => limitKw),
        markLine: {
          symbol: "none",
          label: { formatter: "变压器红线", color: "#b91c1c" },
          lineStyle: { color: "#b91c1c", type: "dashed", width: 1.5 },
          data: [{ yAxis: limitKw }]
        }
      }] : [])
    ]
  });

  window.addEventListener("resize", () => chart.resize());
}

function aggregateAnnualSeries(values, bucketSize, mode = "max") {
  const source = Array.isArray(values) ? values : [];
  const result = [];
  for (let start = 0; start < source.length; start += bucketSize) {
    const slice = source.slice(start, start + bucketSize).map((value) => Number(value || 0));
    if (!slice.length) continue;
    if (mode === "avg") {
      result.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
    } else {
      result.push(Math.max(...slice));
    }
  }
  return result;
}

function buildM2AnnualReferenceSeries(m2Result, totalTicks, bucketSize) {
  const m2Load = m2Result?.chartData?.ev || [];
  if (!Array.isArray(m2Load) || !m2Load.length || !Number.isFinite(totalTicks) || totalTicks <= 0) {
    return [];
  }

  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthIndex = Number(m2Result?.summary?.monthIndex ?? m2Result?.sourceParams?.monthIndex ?? 0);
  const safeMonthIndex = Math.max(0, Math.min(11, Number.isFinite(monthIndex) ? monthIndex : 0));
  const monthStartTick = monthDays.slice(0, safeMonthIndex).reduce((sum, days) => sum + days * 96, 0);
  const pointCount = Math.ceil(totalTicks / bucketSize);
  const reference = Array(pointCount).fill(null);

  m2Load.forEach((value, index) => {
    const annualTick = monthStartTick + index;
    if (annualTick < 0 || annualTick >= totalTicks) return;
    const bucketIndex = Math.floor(annualTick / bucketSize);
    const loadValue = Number(value || 0);
    reference[bucketIndex] = reference[bucketIndex] == null
      ? loadValue
      : Math.max(reference[bucketIndex], loadValue);
  });

  return reference;
}

function renderM3AnnualStressEChart(container, annualResult, selectedRoute, m2Result = null) {
  const chartData = annualResult?.rawAnnual?.chartData || annualResult?.chartData;
  const demand = chartData?.demand || [];
  if (!container || !chartData || !Array.isArray(demand) || demand.length === 0) {
    resetInsightChart(container, "完成 M3-B 全年验证后展示全年压力测试曲线。");
    return;
  }

  const previousChartEl = container.querySelector("[data-m3-annual-stress-echart]");
  if (previousChartEl && typeof echarts !== "undefined") {
    const previous = echarts.getInstanceByDom(previousChartEl);
    if (previous) previous.dispose();
  }

  if (typeof echarts === "undefined") {
    resetInsightChart(container, "ECharts 未加载，暂无法展示全年压力测试曲线。");
    return;
  }

  const bucketSize = demand.length > 9000 ? 4 : 1;
  const sampleLabel = bucketSize === 4 ? "小时峰值采样" : "15 分钟采样";
  const dispatched = aggregateAnnualSeries(chartData.demand, bucketSize, "max");
  const rawDemand = aggregateAnnualSeries(chartData.rawDemand, bucketSize, "max");
  const pv = aggregateAnnualSeries(chartData.pv, bucketSize, "max");
  const soc = aggregateAnnualSeries(chartData.soc, bucketSize, "avg");
  const limit = aggregateAnnualSeries(chartData.limit, bucketSize, "max");
  const m2Reference = buildM2AnnualReferenceSeries(m2Result, demand.length, bucketSize);
  const hasM2Reference = m2Reference.some((value) => value != null);
  const pointsPerDay = Math.max(1, Math.round(96 / bucketSize));
  const axis = dispatched.map((_, index) => {
    const day = Math.floor(index / pointsPerDay) + 1;
    const slot = index % pointsPerDay;
    const hour = bucketSize === 4 ? slot : Math.floor(slot / 4);
    const minute = bucketSize === 4 ? 0 : (slot % 4) * 15;
    return `D${day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  });
  const limitKw = Math.max(...limit.map((value) => Number(value || 0)), 0);
  const powerValues = [...dispatched, ...rawDemand, ...pv, ...m2Reference]
    .filter((value) => value != null)
    .map((value) => Number(value || 0));
  const curveMaxKw = Math.max(...powerValues, 1);
  const showLimit = Number.isFinite(limitKw) && limitKw > 0 && limitKw <= curveMaxKw * 1.18;
  const powerAxisMax = Math.ceil((Math.max(curveMaxKw, showLimit ? limitKw : 0) * 1.12) / 10) * 10;
  const annualMonthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const m2MonthIndex = Number(m2Result?.summary?.monthIndex ?? m2Result?.sourceParams?.monthIndex ?? 0);
  const safeM2MonthIndex = Math.max(0, Math.min(11, Number.isFinite(m2MonthIndex) ? m2MonthIndex : 0));
  const initialStart = hasM2Reference
    ? annualMonthDays.slice(0, safeM2MonthIndex).reduce((sum, days) => sum + days, 0) / 365 * 100
    : 0;
  const initialEnd = Math.min(100, initialStart + (annualMonthDays[safeM2MonthIndex] || 31) / 365 * 100);

  container.innerHTML = `
    <div class="worst-day-note">
      <strong>${annualResult?.selectedRouteLabel || selectedRoute?.label || "所选路线"} 全年连续曲线</strong>
      <span>${sampleLabel} · 原始压力 / ${hasM2Reference ? "M2 压力月负荷 / " : ""}调度后负荷 / 光伏出力 / 储能 SOC</span>
    </div>
    <div class="m3-annual-stress-echart" data-m3-annual-stress-echart></div>
  `;

  const chartEl = container.querySelector("[data-m3-annual-stress-echart]");
  const chart = echarts.init(chartEl);
  chart.setOption({
    textStyle: { fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' },
    animation: false,
    color: ["#475569", "#ef4444", "#2454d6", "#008f9c", "#d97706"],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: "rgba(255, 255, 255, 0.96)",
      borderColor: "#E2E8F0",
      padding: [10, 12],
      textStyle: { color: "#1E293B", fontSize: 12 },
      extraCssText: "box-shadow: 0 12px 24px rgba(15, 23, 42, 0.12); border-radius: 8px;"
    },
    legend: {
      top: 0,
      left: 4,
      icon: "roundRect",
      itemWidth: 16,
      itemHeight: 4,
      itemGap: 14,
      textStyle: { color: "#64748B", fontSize: 12 },
      data: hasM2Reference
        ? ["原始压力", "M2 压力月负荷", "调度后负荷", "光伏出力", "储能 SOC"]
        : ["原始压力", "调度后负荷", "光伏出力", "储能 SOC"]
    },
    grid: { left: 58, right: 58, top: 52, bottom: 58, containLabel: true },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none", throttle: 60, start: initialStart, end: initialEnd },
      {
        type: "slider",
        xAxisIndex: 0,
        filterMode: "none",
        bottom: 14,
        height: 24,
        start: initialStart,
        end: initialEnd,
        borderColor: "rgba(15, 23, 42, 0.12)",
        fillerColor: "rgba(0, 143, 156, 0.14)",
        handleStyle: { color: "#008f9c" },
        textStyle: { color: "#64748B" }
      }
    ],
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: axis,
      axisLabel: { color: "#64748B", hideOverlap: true },
      axisLine: { lineStyle: { color: "#CBD5E1" } },
      axisTick: { show: false }
    },
    yAxis: [
      {
        type: "value",
        name: "kW",
        min: 0,
        max: powerAxisMax,
        nameTextStyle: { color: "#94A3B8" },
        axisLabel: { color: "#64748B" },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: "#EEF2F7", type: "dashed" } }
      },
      {
        type: "value",
        name: "SOC",
        min: 0,
        max: 160,
        nameTextStyle: { color: "#94A3B8" },
        interval: 50,
        axisLabel: {
          color: "#64748B",
          formatter: (value) => value <= 100 && value % 50 === 0 ? `${value}%` : ""
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: "原始压力",
        type: "line",
        yAxisIndex: 0,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.4, color: "#94a3b8", type: "dashed" },
        data: rawDemand
      },
      ...(hasM2Reference ? [{
        name: "M2 压力月负荷",
        type: "line",
        yAxisIndex: 0,
        smooth: true,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 1.8, color: "#ef4444", type: "dashed", opacity: 0.9 },
        data: m2Reference
      }] : []),
      {
        name: "调度后负荷",
        type: "line",
        yAxisIndex: 0,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2.2 },
        areaStyle: { opacity: 0.08 },
        data: dispatched
      },
      {
        name: "光伏出力",
        type: "line",
        yAxisIndex: 0,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.8 },
        areaStyle: { opacity: 0.06 },
        data: pv
      },
      {
        name: "储能 SOC",
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.8, color: "#d97706", opacity: 0.82 },
        data: soc
      },
      ...(showLimit ? [{
        name: "变压器红线",
        type: "line",
        yAxisIndex: 0,
        showSymbol: false,
        silent: true,
        lineStyle: { width: 0 },
        data: dispatched.map(() => limitKw),
        markLine: {
          symbol: "none",
          label: { formatter: "变压器红线", color: "#b91c1c" },
          lineStyle: { color: "#b91c1c", type: "dashed", width: 1.5 },
          data: [{ yAxis: limitKw }]
        }
      }] : [])
    ]
  });

  window.addEventListener("resize", () => chart.resize());
}

function renderCapexStackChart(container, economics) {
  if (!container || !economics) {
    resetInsightChart(container, "运行 M1 后展示投资构成。");
    return;
  }

  const items = [
    { label: "光伏", value: Number(economics.pvCapexWan || 0), className: "pv" },
    { label: "储能容量", value: Number(economics.storageEnergyCapexWan || 0), className: "storage" },
    { label: "PCS", value: Number(economics.storagePowerCapexWan || 0), className: "pcs" },
    { label: "充电桩", value: Number(economics.chargerCapexWan || 0), className: "charger" },
    { label: "EMS", value: Number(economics.emsCapexWan || 0), className: "ems" }
  ].filter((item) => item.value > 0);

  const total = items.reduce((sum, item) => sum + item.value, 0);

  if (total <= 0) {
    resetInsightChart(container, "暂无投资构成数据。");
    return;
  }

  const segments = items.map((item) => {
    const pct = (item.value / total) * 100;
    return `<span class="stack-segment ${item.className}" style="width:${pct}%"><em>${pct >= 12 ? `${formatNumber(pct, 0)}%` : ""}</em></span>`;
  }).join("");

  const rows = items.map((item) => {
    const pct = (item.value / total) * 100;
    return `
      <div class="stack-row">
        <span><i class="stack-dot ${item.className}"></i>${item.label}</span>
        <strong>${formatNumber(item.value, 1)} 万</strong>
        <em>${formatNumber(pct, 1)}%</em>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="stack-total">
      <span>总投资</span>
      <strong>${formatNumber(economics.capexWan || total, 1)} 万元</strong>
    </div>
    <div class="stack-bar">${segments}</div>
    <div class="stack-rows">${rows}</div>
  `;
}

function renderM2RiskHeatmap(container, result) {
  const chartData = result?.chartData;
  const ev = chartData?.ev || [];
  const soc = chartData?.soc || [];
  const queue = chartData?.queue || [];
  const limitKw = Number(result?.summary?.transformerLimitKw || 0);

  if (!container || !Array.isArray(ev) || ev.length === 0) {
    resetInsightChart(container, "运行 M2 后展示日风险分布。");
    return;
  }

  const pointsPerDay = 96;
  const days = Math.max(1, Math.floor(ev.length / pointsPerDay));
  const cells = [];

  for (let day = 0; day < days; day++) {
    const start = day * pointsPerDay;
    const dayLoad = ev.slice(start, start + pointsPerDay).map((v) => Number(v || 0));
    const daySoc = soc.slice(start, start + pointsPerDay).map((v) => Number(v || 100));
    const dayQueue = queue.slice(start, start + pointsPerDay).map((v) => Number(v || 0));
    const overflowTicks = limitKw > 0 ? dayLoad.filter((v) => v > limitKw).length : 0;
    const peak = Math.max(...dayLoad, 0);
    const minSoc = Math.min(...daySoc, 100);
    const queuePeak = Math.max(...dayQueue, 0);
    const riskScore = Math.min(3, (overflowTicks > 0 ? 1 : 0) + (overflowTicks > 8 ? 1 : 0) + (minSoc < 8 ? 1 : 0) + (queuePeak > 0 ? 1 : 0));
    const className = riskScore === 0 ? "safe" : riskScore === 1 ? "warn" : riskScore === 2 ? "high" : "critical";

    cells.push(`
      <span class="risk-cell ${className}">
        <strong>${day + 1}</strong>
        <em>峰值 ${formatNumber(peak, 0)} kW / 越限 ${overflowTicks} tick / 排队峰值 ${formatNumber(queuePeak, 0)} / SOC ${formatNumber(minSoc, 1)}%</em>
      </span>
    `);
  }

  container.innerHTML = `
    <div class="risk-heatmap-grid">${cells.join("")}</div>
    <div class="risk-legend">
      <span><i class="risk-dot safe"></i>安全</span>
      <span><i class="risk-dot warn"></i>轻微风险</span>
      <span><i class="risk-dot high"></i>高风险</span>
      <span><i class="risk-dot critical"></i>严重风险</span>
    </div>
  `;
}

function renderAnnualBarChart(container, values, options = {}) {
  if (!container) return;

  const {
    maxValue = Math.max(...values, 1),
    formatter = (v) => String(v),
    dangerJudge = () => false,
    inverse = false
  } = options;

  if (!Array.isArray(values) || values.length === 0) {
    resetAnnualChart(container);
    return;
  }

  container.innerHTML = values.map((value, index) => {
    const rawRatio = maxValue > 0 ? value / maxValue : 0;
    const ratio = inverse ? 1 - clamp01(rawRatio) : clamp01(rawRatio);
    const heightPct = Math.max(6, ratio * 100);
    const danger = dangerJudge(value, index);

    return `
      <div class="annual-bar-item ${danger ? "danger" : ""}">
        <div class="annual-bar-value">${formatter(value)}</div>
        <div class="annual-bar-track">
          <div class="annual-bar-fill" style="height:${heightPct}%"></div>
        </div>
        <div class="annual-bar-label">${MONTH_LABELS[index] || `${index + 1}月`}</div>
      </div>
    `;
  }).join("");
}

function monthLabel(index) {
  return MONTH_LABELS[index] || `${index + 1}月`;
}

function getTopRiskMonths(monthlyUnmet, monthlyService, monthlyOverflow, monthlySoc) {
  const maxUnmet = Math.max(...monthlyUnmet, 1);
  const maxOverflow = Math.max(...monthlyOverflow, 1);

  return monthlyUnmet
    .map((unmet, index) => {
      const service = monthlyService[index] ?? 1;
      const overflow = monthlyOverflow[index] ?? 0;
      const soc = monthlySoc[index] ?? 100;

      const unmetScore = unmet > 0 ? unmet / maxUnmet : 0;
      const serviceScore = service < 0.95 ? (0.95 - service) / 0.95 : 0;
      const overflowScore = overflow > 0 ? overflow / maxOverflow : 0;
      const socScore = soc < 8 ? (8 - soc) / 8 : 0;

      const score =
        unmetScore * 0.40 +
        serviceScore * 0.30 +
        overflowScore * 0.15 +
        socScore * 0.15;

      return { index, label: monthLabel(index), score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function getAnnualMainRisk(annual) {
  const totalUnmet = Number(annual?.totalUnmetKwh || 0);
  const serviceRate = Number(annual?.serviceRate || 0);
  const overflowMonths = Number(annual?.monthsWithOverflow || 0);
  const socRiskMonths = Number(annual?.monthsWithSocRisk || 0);

  if (totalUnmet > 0 && serviceRate < 0.95) return "服务缺口偏高";
  if (socRiskMonths > 0) return "储能韧性不足";
  if (overflowMonths > 0) return "配电越限仍存在";
  if (totalUnmet > 0) return "仍有交付缺口";
  return "无显著年度残余风险";
}

function getAnnualJudgement(annual) {
  const totalUnmet = Number(annual?.totalUnmetKwh || 0);
  const serviceRate = Number(annual?.serviceRate || 0);
  const overflowMonths = Number(annual?.monthsWithOverflow || 0);
  const socRiskMonths = Number(annual?.monthsWithSocRisk || 0);

  if (totalUnmet <= 0 && serviceRate >= 0.99 && overflowMonths === 0 && socRiskMonths === 0) {
    return "全年表现基本稳健";
  }
  return "仍需进入 M4 加固";
}

function getM4FocusText(annual) {
  const totalUnmet = Number(annual?.totalUnmetKwh || 0);
  const serviceRate = Number(annual?.serviceRate || 0);
  const overflowMonths = Number(annual?.monthsWithOverflow || 0);
  const socRiskMonths = Number(annual?.monthsWithSocRisk || 0);

  if (socRiskMonths > 0 && totalUnmet > 0) return "重点评估服务交付与储能韧性";
  if (overflowMonths > 0) return "优先压降功率越限风险";
  if (serviceRate < 0.95 || totalUnmet > 0) return "优先修复全年服务缺口";
  return "重点比较工程代价与稳健性";
}

function renderTabs(state) {
  dom.stageTabs.forEach((tab) => {
    const stageKey = tab.dataset.stage;
    const stage = state.stages[stageKey];
    tab.classList.toggle("active", state.activeStage === stageKey);
    tab.classList.toggle("locked", stage.status === "locked");
  });
}

function renderPanels(state) {
  dom.stagePanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === state.activeStage);
  });
}

function renderButtons(state) {
  Object.entries(dom.buttons).forEach(([key, button]) => {
    const stage = state.stages[key];
    button.disabled = stage.status === "locked" || stage.status === "running";

    if (stage.status === "running") {
      button.textContent = "计算中...";
    } else if (stage.status === "done") {
      button.textContent =
        key === "m1" ? "重新运行 M1 真实规划" :
        key === "m2" ? "重新运行 M2 压力测试" :
        key === "m3" ? "重新运行 M3 价格调度" :
        key === "m4" ? "重新运行 M4 最终方案定型" :
        `重新运行 ${key.toUpperCase()}`;
    } else {
      button.textContent =
        key === "m1" ? "运行 M1 真实规划" :
        key === "m2" ? "运行 M2 压力测试" :
        key === "m3" ? "运行 M3 价格调度" :
        key === "m4" ? "运行 M4 最终方案定型" :
        `运行 ${key.toUpperCase()}`;
    }
  });
}

function renderRawResults(state) {
  Object.entries(dom.results).forEach(([key, resultEl]) => {
    const stage = state.stages[key];

    if (stage.error) {
      resultEl.textContent = `${key.toUpperCase()} 出错：${stage.error}`;
      return;
    }

    if (!stage.result) {
      resultEl.textContent =
        stage.status === "locked"
          ? `${key.toUpperCase()} 尚未解锁。`
          : `尚未运行 ${key.toUpperCase()}。`;
      return;
    }

    let safeResult = stage.result;
    if (key === "m1") {
      safeResult = {
        contract: stage.result.contract,
        summary: stage.result.summary,
        hardwarePlan: stage.result.hardwarePlan,
        economics: stage.result.economics,
        energyPerformance: stage.result.energyPerformance,
        demandProfile: stage.result.demandProfile
      };
    } else if (key === "m2") {
      safeResult = {
        contract: stage.result.contract,
        summary: stage.result.summary,
        hardwareSnapshot: stage.result.hardwareSnapshot,
        riskReport: stage.result.riskReport,
        energyLedger: stage.result.energyLedger,
        occupancyReference: stage.result.occupancyReference,
        handoffToM3: stage.result.handoffToM3
      };
    } else if (key === "m3") {
      safeResult = {
        contract: stage.result.contract,
        summary: stage.result.summary,
        baselineFromM2: stage.result.baselineFromM2,
        routeOptions: stage.result.routeOptions,
        selectedRoute: state.input.m3.selectedRoute || null,
        selectedAnnualValidation: stage.result.selectedAnnualValidation || null
      };
    } else if (key === "m4") {
      safeResult = {
        contract: stage.result.contract,
        summary: stage.result.summary,
        residualDiagnosis: stage.result.residualDiagnosis,
        recommendation: stage.result.recommendation,
        scenarios: stage.result.scenarios.map((s) => ({
          id: s.id,
          title: s.title,
          extraCapexWan: s.extraCapexWan,
          stressMonth: s.stressMonth,
          annualValidation: s.annualValidation,
          evaluationIndicators: s.evaluationIndicators,
          recommendation: s.recommendation
        }))
      };
    }

    resultEl.textContent = JSON.stringify(safeResult, null, 2);
  });
}

function renderM1CapexEChart(container, economics) {
  if (!container || typeof echarts === "undefined") return;

  const existing = echarts.getInstanceByDom(container);
  if (existing) existing.dispose();

  const chart = echarts.init(container);

  chart.setOption({
    textStyle: { fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: "rgba(255, 255, 255, 0.95)",
      borderColor: "#E2E8F0",
      padding: [12, 16],
      textStyle: { color: "#1E293B" },
      extraCssText: "box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); border-radius: 8px;"
    },
    legend: {
      data: ["光伏", "储能", "PCS", "充电桩", "EMS"],
      bottom: "0%",
      icon: "circle",
      itemGap: 20,
      textStyle: { color: "#64748B", fontSize: 13 }
    },
    grid: {
      top: "15%", left: "2%", right: "4%", bottom: "20%", containLabel: true,
      show: false
    },
    xAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: "#94A3B8" },
      splitLine: { show: true, lineStyle: { color: "#F1F5F9", type: "dashed" } }
    },
    yAxis: {
      type: "category",
      data: ["投资构成"],
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false }
    },
    series: [
      { name: "光伏", type: "bar", stack: "total", barWidth: 32, itemStyle: { color: "#008f9c", borderRadius: [4, 0, 0, 4] }, data: [economics.pvCapexWan || 0] },
      { name: "储能", type: "bar", stack: "total", itemStyle: { color: "#0f766e" }, data: [economics.storageEnergyCapexWan || 0] },
      { name: "PCS", type: "bar", stack: "total", itemStyle: { color: "#2454d6" }, data: [economics.storagePowerCapexWan || 0] },
      { name: "充电桩", type: "bar", stack: "total", itemStyle: { color: "#d97706" }, data: [economics.chargerCapexWan || 0] },
      { name: "EMS", type: "bar", stack: "total", itemStyle: { color: "#94a3b8", borderRadius: [0, 4, 4, 0] }, data: [economics.emsCapexWan || 0] }
    ]
  });

  window.addEventListener("resize", () => chart.resize());
}

function renderM1PowerEChart(container, chartData) {
  if (!container || typeof echarts === "undefined" || !chartData) return;

  const existing = echarts.getInstanceByDom(container);
  if (existing) existing.dispose();

  const chart = echarts.init(container);

  const rawHours = Array.isArray(chartData.pv) ? chartData.pv.length : 96;
  const hoursAxis = Array.from({ length: rawHours }, (_, i) => {
    const hour = i % 24;
    return hour === 0 ? `H${i}` : "";
  });

  chart.setOption({
    textStyle: { fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(255, 255, 255, 0.95)",
      borderColor: "#E2E8F0",
      padding: 12,
      extraCssText: "box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); border-radius: 8px;"
    },
    legend: {
      data: ["充电负荷", "光伏出力", "SOC (%)"],
      top: "0%",
      icon: "roundRect",
      itemWidth: 16, itemHeight: 4,
      textStyle: { color: "#64748B", fontSize: 13 }
    },
    grid: {
      top: "18%", left: "2%", right: "2%", bottom: "8%", containLabel: true,
      show: false
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" }
    ],
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: hoursAxis,
      axisLine: { lineStyle: { color: "#CBD5E1" } },
      axisTick: { show: false },
      axisLabel: { color: "#64748B" }
    },
    yAxis: [
      {
        type: "value",
        name: "功率 (kW)",
        nameTextStyle: { color: "#94A3B8", padding: [0, 30, 0, 0] },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#64748B" },
        splitLine: { show: true, lineStyle: { color: "#F1F5F9", type: "dashed" } }
      },
      {
        type: "value",
        name: "SOC (%)",
        nameTextStyle: { color: "#94A3B8", padding: [0, 0, 0, 30] },
        min: 0, max: 100,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#64748B" },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: "充电负荷", type: "line", yAxisIndex: 0,
        smooth: true, showSymbol: false,
        lineStyle: { color: "#2454d6", width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(36, 84, 214, 0.25)" },
            { offset: 1, color: "rgba(36, 84, 214, 0.02)" }
          ])
        },
        data: chartData.ev || []
      },
      {
        name: "光伏出力", type: "line", yAxisIndex: 0,
        smooth: true, showSymbol: false,
        lineStyle: { color: "#008f9c", width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(0, 143, 156, 0.25)" },
            { offset: 1, color: "rgba(0, 143, 156, 0.02)" }
          ])
        },
        data: chartData.pv || []
      },
      {
        name: "SOC (%)", type: "line", yAxisIndex: 1,
        smooth: true, showSymbol: false,
        lineStyle: { color: "#10B981", width: 2.5 },
        data: chartData.soc || []
      }
    ]
  });

  window.addEventListener("resize", () => chart.resize());
}

function renderM1Summary(state) {
  const result = state.stages.m1.result;
  const el = dom.m1Summary;

  if (!result) {
    el.title.textContent = "系统基准规划方案尚未生成";
    el.meta.textContent = "配置左侧 Table 参数后点击右上方按钮执行连续仿真计算。";
    resetInsightChart(el.capexChart, "运行 M1 后展示投资构成。");
    resetInsightChart(el.powerChart, "运行 M1 后展示标准周功率模拟。");
    return;
  }

  const { summary, hardwarePlan, economics, energyPerformance, demandProfile } = result;
  el.title.textContent = summary.title;
  el.meta.textContent = `${summary.city} · ${summary.climateZone} · 新能源目标 ${formatPercent(summary.renewableTarget, 0)}%`;

  el.pv.textContent = formatNumber(hardwarePlan.pvKw, 1);
  el.storage.textContent = formatNumber(hardwarePlan.storageKwh, 1);
  el.pcs.textContent = formatNumber(hardwarePlan.pcsKw, 1);
  el.capex.textContent = formatNumber(economics.capexWan, 2);
  el.piles.textContent = `${hardwarePlan.n7kw} / ${hardwarePlan.n30kw}`;
  el.renewable.textContent = formatPercent(energyPerformance.renewableShare, 1);
  el.dailyKwh.textContent = formatNumber(demandProfile.totalDailyKwh, 1);
  el.lcoe.textContent = formatNumber(economics.lcoeYuanPerKwh, 3);

  el.peak.textContent = `${formatNumber(demandProfile.peakLoadKw, 1)} kW`;
  el.avgNeed.textContent = `${formatNumber(demandProfile.averageSessionNeedKwh, 1)} kWh`;
  el.curtailment.textContent = `${formatNumber(energyPerformance.curtailmentRatePct, 1)}%`;
  el.gridAnnual.textContent = `${formatNumber(energyPerformance.gridBuyAnnualKwh, 1)} kWh`;

  renderM1CapexEChart(el.capexChart, economics);
  renderM1PowerEChart(el.powerChart, result.chartData);
}

function renderM2Summary(state) {
  const result = state.stages.m2.result;
  const m1 = state.stages.m1.result;
  const el = dom.m2Summary;

  if (m1?.hardwarePlan) {
    el.inheritPv.textContent = `${formatNumber(m1.hardwarePlan.pvKw, 1)} kW`;
    el.inheritStorage.textContent = `${formatNumber(m1.hardwarePlan.storageKwh, 1)} kWh`;
    el.inheritPcs.textContent = `${formatNumber(m1.hardwarePlan.pcsKw, 1)} kW`;
    el.inheritPiles.textContent = `${m1.hardwarePlan.n7kw} / ${m1.hardwarePlan.n30kw}`;
  } else {
    el.inheritPv.textContent = "-- kW";
    el.inheritStorage.textContent = "-- kWh";
    el.inheritPcs.textContent = "-- kW";
    el.inheritPiles.textContent = "--";
  }

  if (!result) {
    el.title.textContent = "M2 尚未运行。";
    el.meta.textContent = state.input.m2.gTiltData
      ? "气象数据已就绪，可以运行真实月压力测试。"
      : "上传气象 CSV 后，运行真实月压力测试。";
    resetInsightChart(el.powerChart, "运行 M2 后展示压力月功率画像。");
    resetInsightChart(el.riskHeatmap, "运行 M2 后展示日风险分布。");
    return;
  }

  const { summary, riskReport, energyLedger, handoffToM3, occupancyReference } = result;
  el.title.textContent = summary.title;
  el.meta.textContent = `${summary.monthName} · 变压器红线 ${formatNumber(summary.transformerLimitKw, 0)} kW · 利用率 ${formatNumber(summary.transformerUtilPct, 1)}%`;
  el.realPeak.textContent = formatNumber(riskReport.realPeakKw, 1);
  el.overflow.textContent = String(riskReport.overflowCount);
  el.unmet.textContent = formatNumber(riskReport.unmetTotalKwh, 1);
  el.abandoned.textContent = String(riskReport.abandonedCount);
  el.socMin.textContent = formatNumber(riskReport.socMinPct, 1);
  el.transUtil.textContent = formatNumber(summary.transformerUtilPct, 1);
  el.gridCost.textContent = formatNumber(energyLedger.gridCostYuan, 1);
  el.curtailment.textContent = formatNumber(energyLedger.curtailmentRatePct, 2);

  el.riskPeak.textContent = handoffToM3.hasPeakRisk ? "有" : "无";
  el.riskService.textContent = handoffToM3.hasServiceRisk ? "有" : "无";
  el.riskStorage.textContent = handoffToM3.hasStorageRisk ? "有" : "无";
  el.fixedP99.textContent = String(occupancyReference.fixedReadyP99);

  renderM2MonthEChart(el.powerChart, result);
  renderM2RiskHeatmap(el.riskHeatmap, result);
}

function getImprovementText(base, next, mode = "lower") {
  if (!Number.isFinite(base) || !Number.isFinite(next)) return "--";

  const delta = next - base;

  if (mode === "higher") {
    if (Math.abs(delta) < 0.01) return "持平";
    return delta > 0
      ? `提升 ${formatNumber(delta, 1)} pct`
      : `下降 ${formatNumber(Math.abs(delta), 1)} pct`;
  }

  if (Math.abs(delta) < 0.01) return "持平";

  if (base > 0) {
    const rate = ((base - next) / base) * 100;
    return rate >= 0
      ? `改善 ${formatNumber(rate, 1)}%`
      : `增加 ${formatNumber(Math.abs(rate), 1)}%`;
  }

  return next <= base ? "无新增风险" : `新增 ${formatNumber(next - base, 1)}`;
}

function renderM3BaselineLiftChart(container, baseline, traditional, flexible) {
  if (!container || !baseline || !traditional?.result) {
    resetInsightChart(container, "运行 M3 后展示价格调度相对压力基线的改善效果。");
    return;
  }

  const metrics = [
    {
      label: "总缺口",
      unit: "kWh",
      baseline: Number(baseline.unmetTotalKwh || 0),
      traditional: Number(traditional.result.unmetTotalKwh || 0),
      mode: "lower"
    },
    {
      label: "排队缺口",
      unit: "kWh",
      baseline: Number(baseline.queueUnmetKwh || 0),
      traditional: Number(traditional.result.queueUnmetKwh || 0),
      mode: "lower"
    },
    {
      label: "峰值功率",
      unit: "kW",
      baseline: Number(baseline.realPeakKw || 0),
      traditional: Number(traditional.result.realPeakKw || 0),
      mode: "lower"
    },
    {
      label: "越限次数",
      unit: "次",
      baseline: Number(baseline.overflowCount || 0),
      traditional: Number(traditional.result.overflowCount || 0),
      mode: "lower"
    },
    {
      label: "最低 SOC",
      unit: "%",
      baseline: Number(baseline.socMinPct || 0),
      traditional: Number(traditional.result.socMinPct || 0),
      mode: "higher"
    }
  ];

  const routeCards = [
    {
      key: "traditional",
      title: "传统桩站价格调度",
      badge: traditional.handoffToM4?.needsHardwareReinforcement ? "仍需 M4 加固" : "可直接承接",
      values: metrics.map((metric) => ({ ...metric, routeValue: metric.traditional }))
    }
  ];

  if (flexible?.result) {
    const flexMetrics = [
      {
        label: "总缺口",
        unit: "kWh",
        baseline: Number(baseline.unmetTotalKwh || 0),
        traditional: Number(flexible.result.unmetTotalKwh || 0),
        mode: "lower"
      },
      {
        label: "排队缺口",
        unit: "kWh",
        baseline: Number(baseline.queueUnmetKwh || 0),
        traditional: Number(flexible.result.queueUnmetKwh || 0),
        mode: "lower"
      },
      {
        label: "峰值功率",
        unit: "kW",
        baseline: Number(baseline.realPeakKw || 0),
        traditional: Number(flexible.result.realPeakKw || 0),
        mode: "lower"
      },
      {
        label: "越限次数",
        unit: "次",
        baseline: Number(baseline.overflowCount || 0),
        traditional: Number(flexible.result.overflowCount || 0),
        mode: "lower"
      },
      {
        label: "最低 SOC",
        unit: "%",
        baseline: Number(baseline.socMinPct || 0),
        traditional: Number(flexible.result.socMinPct || 0),
        mode: "higher"
      }
    ];

    routeCards.push({
      key: "flexible",
      title: "柔性调度（已移除）",
      badge: "已移除",
      values: flexMetrics.map((metric) => ({ ...metric, routeValue: metric.traditional }))
    });
  }

  container.innerHTML = routeCards.map((route) => {
    const rows = route.values.map((metric) => {
      const metricValue = route.key === "flexible" ? metric.traditional : metric.routeValue;
      const maxValue = Math.max(metric.baseline, metricValue, 1);
      const baselineWidth = Math.max(5, (metric.baseline / maxValue) * 100);
      const routeWidth = Math.max(5, (metricValue / maxValue) * 100);
      const improvement = getImprovementText(metric.baseline, metricValue, metric.mode);
      const isBetter = metric.mode === "higher"
        ? metricValue > metric.baseline
        : metricValue < metric.baseline;
      const isWorse = metric.mode === "higher"
        ? metricValue < metric.baseline
        : metricValue > metric.baseline;

      return `
        <section class="baseline-lift-row ${isBetter ? "better" : ""} ${isWorse ? "worse" : ""}">
          <div class="baseline-lift-row-head">
            <strong>${metric.label}</strong>
            <em>${improvement}</em>
          </div>

          <div class="baseline-lift-bar-line">
            <span>基准</span>
            <div class="baseline-lift-track">
              <div class="baseline-lift-fill base" style="width:${baselineWidth}%"></div>
            </div>
            <strong>${formatNumber(metric.baseline, 1)} ${metric.unit}</strong>
          </div>

          <div class="baseline-lift-bar-line">
            <span>路线后</span>
            <div class="baseline-lift-track">
              <div class="baseline-lift-fill ${route.key}" style="width:${routeWidth}%"></div>
            </div>
            <strong>${formatNumber(metricValue, 1)} ${metric.unit}</strong>
          </div>
        </section>
      `;
    }).join("");

    return `
      <section class="baseline-lift-route ${route.key}">
        <div class="baseline-lift-route-head">
          <h5>${route.title}</h5>
          <span>${route.badge}</span>
        </div>
        ${rows}
      </section>
    `;
  }).join("");
}

function renderM3Summary(state) {
  const result = state.stages.m3.result;
  const m2 = state.stages.m2.result;
  const selectedRouteKey = state.input.m3.selectedRoute;
  const el = dom.m3Summary;

  const resetAnnualSummary = () => {
    el.annualMeta.textContent = "选择技术路线后，将自动执行全年 365 天连续调度验证。";
    el.annualUnmet.textContent = "-- kWh";
    el.annualService.textContent = "--%";
    el.annualOverflowMonths.textContent = "--";
    el.annualSocMonths.textContent = "--";

    el.annualConclusionText.textContent =
      "完成所选路线全年验证后，这里将自动提炼年度判断与进入 M4 的依据。";
    el.annualJudgement.textContent = "--";
    el.annualMainRisk.textContent = "--";
    el.annualFocusMonths.textContent = "--";
    el.annualM4Focus.textContent = "--";

    el.annualStressMeta.textContent = "完成所选路线全年验证后，这里将展示全年连续调度曲线，用于对照原始压力与调度后负荷。";
    resetInsightChart(el.annualStressChart, "完成 M3-B 全年验证后展示全年压力测试曲线。");
    el.annualChartMeta.textContent = "完成所选路线全年验证后，这里将展示 12 个月风险分布。";
    resetAnnualChart(el.annualUnmetChart);
    resetAnnualChart(el.annualServiceChart);
    resetAnnualChart(el.annualOverflowChart);
    resetAnnualChart(el.annualSocChart);
  };

  if (m2?.riskReport) {
    el.baselineMonth.textContent = m2.summary?.monthName || "--";
    el.baselinePeak.textContent = `${formatNumber(m2.riskReport.realPeakKw, 1)} kW`;
    el.baselineUnmet.textContent = `${formatNumber(m2.riskReport.unmetTotalKwh, 1)} kWh`;
    el.baselineQueue.textContent = `${formatNumber(m2.riskReport.queueUnmetKwh, 1)} kWh`;
  } else {
    el.baselineMonth.textContent = "--";
    el.baselinePeak.textContent = "-- kW";
    el.baselineUnmet.textContent = "-- kWh";
    el.baselineQueue.textContent = "-- kWh";
  }

  dom.m3RouteButtons.forEach((button) => {
    button.disabled = !result;
  });

  if (!result) {
    el.title.textContent = "M3 尚未运行。";
    el.meta.textContent = m2 ? "M2 已完成，可以运行价格调度评估。" : "M2 完成后，运行价格调度评估。";
    el.tradPeak.textContent = "-- kW";
    el.tradUnmet.textContent = "-- kWh";
    el.tradQueue.textContent = "-- kWh";
    el.tradStatus.textContent = "--";
    if (el.flexCard) el.flexCard.style.display = "none";
    if (el.flexPeak) el.flexPeak.textContent = "-- kW";
    if (el.flexUnmet) el.flexUnmet.textContent = "-- kWh";
    if (el.flexNMatrix) el.flexNMatrix.textContent = "--";
    if (el.flexStatus) el.flexStatus.textContent = "--";
    el.tradSelected.textContent = "未选择";
    if (el.flexSelected) el.flexSelected.textContent = "已移除";
    el.selectedRoute.textContent = "尚未选择";
    el.selectedNeed.textContent = "--";
    el.selectedUnmet.textContent = "-- kWh";
    el.selectedOverflow.textContent = "-- 次";
    el.tradCard?.classList.remove("selected");
    if (el.flexCard) el.flexCard.style.display = "none";
    resetInsightChart(el.routeCompareChart, "运行 M3 后展示价格调度相对压力基线的改善效果。");
    resetAnnualSummary();
    return;
  }

  const traditional = result.routeOptions.traditional_pile;

  renderM3BaselineLiftChart(
    el.routeCompareChart,
    m2?.riskReport,
    traditional,
    null
  );

  const selectedRoute = selectedRouteKey ? result.routeOptions[selectedRouteKey] : null;

  el.title.textContent = result.summary.title;
  el.meta.textContent = selectedRoute
    ? `已选择：${selectedRoute.label}。系统将完成全年连续验证，再进入 M4 工程方案定型。`
    : "价格调度路线已生成，请选择传统桩站价格调度进入 M3-B 全年验证。";

  el.tradPeak.textContent = `${formatNumber(traditional.result.realPeakKw, 1)} kW`;
  el.tradUnmet.textContent = `${formatNumber(traditional.result.unmetTotalKwh, 1)} kWh`;
  el.tradQueue.textContent = `${formatNumber(traditional.result.queueUnmetKwh, 1)} kWh`;
  el.tradStatus.textContent = traditional.handoffToM4.needsHardwareReinforcement ? "需要" : "不需要";

  if (el.flexCard) el.flexCard.style.display = "none";
  if (el.flexPeak) el.flexPeak.textContent = "-- kW";
  if (el.flexUnmet) el.flexUnmet.textContent = "-- kWh";
  if (el.flexNMatrix) el.flexNMatrix.textContent = "--";
  if (el.flexStatus) el.flexStatus.textContent = "--";
  if (el.flexSelected) el.flexSelected.textContent = "已移除";

  const tradSelected = selectedRouteKey === "traditional_pile";
  el.tradSelected.textContent = tradSelected ? "已选择" : "未选择";
  el.tradCard?.classList.toggle("selected", tradSelected);
  if (el.flexCard) el.flexCard.style.display = "none";

  if (!selectedRoute) {
    el.selectedRoute.textContent = "尚未选择";
    el.selectedNeed.textContent = "--";
    el.selectedUnmet.textContent = "-- kWh";
    el.selectedOverflow.textContent = "-- 次";
    resetAnnualSummary();
    return;
  }

  const handoff = selectedRoute.handoffToM4;
  el.selectedRoute.textContent = selectedRoute.label;
  el.selectedNeed.textContent = handoff.needsHardwareReinforcement ? "是" : "否";
  el.selectedUnmet.textContent = `${formatNumber(handoff.residualUnmetKwh, 1)} kWh`;
  el.selectedOverflow.textContent = `${handoff.residualOverflowCount} 次`;

  // M3-B 所选路线全年连续验证摘要
  const annualStatus = state.stages.m3.annualValidationStatus;
  const annualError = state.stages.m3.annualValidationError;
  const annualResult = result.selectedAnnualValidation;
  const annual = annualResult?.annualValidation;

  if (annualStatus === "running") {
    el.annualMeta.textContent = `${selectedRoute.label} 已选择，正在执行全年 365 天连续调度验证……`;
    el.annualUnmet.textContent = "-- kWh";
    el.annualService.textContent = "--%";
    el.annualOverflowMonths.textContent = "--";
    el.annualSocMonths.textContent = "--";

    el.annualConclusionText.textContent = "全年连续验证正在执行，结论将在年度结果返回后生成。";
    el.annualJudgement.textContent = "验证中";
    el.annualMainRisk.textContent = "--";
    el.annualFocusMonths.textContent = "--";
    el.annualM4Focus.textContent = "--";

    el.annualStressMeta.textContent = "正在执行全年连续调度验证，曲线将在结果返回后生成。";
    resetInsightChart(el.annualStressChart, "验证中");
    el.annualChartMeta.textContent = "正在执行全年验证，月度风险画像将在结果返回后生成。";
    resetAnnualChart(el.annualUnmetChart, "验证中");
    resetAnnualChart(el.annualServiceChart, "验证中");
    resetAnnualChart(el.annualOverflowChart, "验证中");
    resetAnnualChart(el.annualSocChart, "验证中");
    return;
  }

  if (annualStatus === "error") {
    el.annualMeta.textContent = `全年验证失败：${annualError || "未知错误"}`;
    el.annualUnmet.textContent = "-- kWh";
    el.annualService.textContent = "--%";
    el.annualOverflowMonths.textContent = "--";
    el.annualSocMonths.textContent = "--";

    el.annualConclusionText.textContent = "全年连续验证失败，暂无法形成年度结论。";
    el.annualJudgement.textContent = "验证失败";
    el.annualMainRisk.textContent = "--";
    el.annualFocusMonths.textContent = "--";
    el.annualM4Focus.textContent = "--";

    el.annualStressMeta.textContent = "全年验证失败，暂无法生成全年压力测试曲线。";
    resetInsightChart(el.annualStressChart, "验证失败");
    el.annualChartMeta.textContent = "全年验证失败，暂无法生成月度风险画像。";
    resetAnnualChart(el.annualUnmetChart, "验证失败");
    resetAnnualChart(el.annualServiceChart, "验证失败");
    resetAnnualChart(el.annualOverflowChart, "验证失败");
    resetAnnualChart(el.annualSocChart, "验证失败");
    return;
  }

  if (!annual) {
    el.annualMeta.textContent = `${selectedRoute.label} 已选择，等待执行全年连续验证。`;
    el.annualUnmet.textContent = "-- kWh";
    el.annualService.textContent = "--%";
    el.annualOverflowMonths.textContent = "--";
    el.annualSocMonths.textContent = "--";

    el.annualConclusionText.textContent = "已完成路线选择，等待年度验证结果后形成结论。";
    el.annualJudgement.textContent = "等待验证";
    el.annualMainRisk.textContent = "--";
    el.annualFocusMonths.textContent = "--";
    el.annualM4Focus.textContent = "--";

    el.annualStressMeta.textContent = "等待全年验证结果返回后生成连续压力测试曲线。";
    resetInsightChart(el.annualStressChart, "暂无数据");
    el.annualChartMeta.textContent = "全年验证结果返回后，这里将展示 12 个月风险分布。";
    resetAnnualChart(el.annualUnmetChart);
    resetAnnualChart(el.annualServiceChart);
    resetAnnualChart(el.annualOverflowChart);
    resetAnnualChart(el.annualSocChart);
    return;
  }

  el.annualMeta.textContent = `${annualResult.selectedRouteLabel || selectedRoute.label} 全年连续验证已完成，M4 已可继续沿该路线进行工程方案定型。`;
  el.annualUnmet.textContent = `${formatNumber(annual.totalUnmetKwh || 0, 1)} kWh`;
  el.annualService.textContent = `${formatPercent(annual.serviceRate || 0, 1)}%`;
  el.annualOverflowMonths.textContent = String(annual.monthsWithOverflow || 0);
  el.annualSocMonths.textContent = String(annual.monthsWithSocRisk || 0);
  el.annualStressMeta.textContent =
    `${annualResult.selectedRouteLabel || selectedRoute.label} 的全年压力测试曲线已生成，可直接对比 M2 压力月负荷、原始压力与调度后负荷。`;
  renderM3AnnualStressEChart(el.annualStressChart, annualResult, selectedRoute, m2);

  // 绘制月度风险画像
  const monthly = annualResult.rawAnnual?.monthly || [];

  if (!monthly.length) {
    el.annualChartMeta.textContent = "全年验证已完成，但未返回月度明细，暂无法绘制月度图表。";
    resetAnnualChart(el.annualUnmetChart);
    resetAnnualChart(el.annualServiceChart);
    resetAnnualChart(el.annualOverflowChart);
    resetAnnualChart(el.annualSocChart);
    return;
  }

  el.annualChartMeta.textContent =
    `${annualResult.selectedRouteLabel || selectedRoute.label} 的全年结果已拆分为 12 个月画像，可用于定位残余风险集中月份。`;

  const monthlyUnmet = monthly.map((m) => Number(m.unmetTotal || 0));
  const monthlyService = monthly.map((m) => {
    const delivered = Number(m.deliveredEnergy || 0);
    const unmet = Number(m.unmetTotal || 0);
    const demand = delivered + unmet;
    return demand > 0 ? delivered / demand : 0;
  });
  const monthlyOverflow = monthly.map((m) => Number(m.overflowCount || 0));
  const monthlySoc = monthly.map((m) => Number(m.socMin ?? 100));

  // 生成年度结论
  const topRiskMonths = getTopRiskMonths(monthlyUnmet, monthlyService, monthlyOverflow, monthlySoc);
  const topRiskMonthText = topRiskMonths.length
    ? topRiskMonths.map((item) => item.label).join(" / ")
    : "无明显集中月份";

  const annualJudgement = getAnnualJudgement(annual);
  const annualMainRisk = getAnnualMainRisk(annual);
  const annualM4Focus = getM4FocusText(annual);

  el.annualJudgement.textContent = annualJudgement;
  el.annualMainRisk.textContent = annualMainRisk;
  el.annualFocusMonths.textContent = topRiskMonthText;
  el.annualM4Focus.textContent = annualM4Focus;

  el.annualConclusionText.textContent =
    annualJudgement === "全年表现基本稳健"
      ? `${annualResult.selectedRouteLabel || selectedRoute.label} 在全年连续验证中未暴露显著结构性风险，可进入 M4 进行最终方案对照与工程定型。`
      : `${annualResult.selectedRouteLabel || selectedRoute.label} 在全年连续验证中仍暴露 ${annualMainRisk}，风险主要集中于 ${topRiskMonthText}，因此需要继续进入 M4 做工程加固定型。`;

  // 绘制月度风险画像
  renderAnnualBarChart(el.annualUnmetChart, monthlyUnmet, {
    maxValue: Math.max(...monthlyUnmet, 1),
    formatter: (v) => `${formatNumber(v, 0)}`,
    dangerJudge: (v) => v > 0
  });

  renderAnnualBarChart(el.annualServiceChart, monthlyService, {
    maxValue: 1,
    formatter: (v) => `${formatPercent(v, 0)}%`,
    dangerJudge: (v) => v < 0.95
  });

  renderAnnualBarChart(el.annualOverflowChart, monthlyOverflow, {
    maxValue: Math.max(...monthlyOverflow, 1),
    formatter: (v) => `${Math.round(v)}`,
    dangerJudge: (v) => v > 0
  });

  renderAnnualBarChart(el.annualSocChart, monthlySoc, {
    maxValue: 100,
    formatter: (v) => `${formatNumber(v, 0)}%`,
    dangerJudge: (v) => v < 8
  });
}


function riskLabel(risk) {
  if (!risk || !risk.active || !risk.level) return "无";
  const map = { low: "低", medium: "中", high: "高" };
  return map[risk.level] || risk.level;
}

function riskDiagnosisText(diagnosis) {
  const parts = [];
  const power = diagnosis.powerRisk || {};
  const energy = diagnosis.energyRisk || {};
  const service = diagnosis.serviceRisk || {};
  const delivery = diagnosis.deliveryServiceRisk || {};
  const storage = diagnosis.storageRisk || {};

  if (power.active) parts.push(`功率:${riskLabel(power)}`);
  if (energy.active) parts.push(`能量:${riskLabel(energy)}`);
  if (service.active) parts.push(`接入:${riskLabel(service)}`);
  if (delivery.active) parts.push(`供电:${riskLabel(delivery)}`);
  if (storage.active) parts.push(`储能:${riskLabel(storage)}`);

  if (!parts.length) return "无显著残余风险";
  return parts.join(" ");
}

function renderM4HandoffBridge(el, selectedRoute, selectedAnnualResult, selectedAnnual, selectedMonthly) {
  if (!selectedRoute) {
    el.handoffSummary.textContent =
      "尚未选择 M3 技术路线。完成 M3-A 并选择路线后，M4 才会获得明确承接对象。";
    el.handoffRoute.textContent = "--";
    el.handoffJudgement.textContent = "--";
    el.handoffMainRisk.textContent = "--";
    el.handoffFocusMonths.textContent = "--";
    el.handoffTask.textContent = "等待技术路线选择。";
    return;
  }

  el.handoffRoute.textContent = selectedRoute.label;

  if (!selectedAnnual) {
    el.handoffSummary.textContent =
      `${selectedRoute.label} 已选定，但 M3-B 全年连续验证尚未完成。`;
    el.handoffJudgement.textContent = "等待全年验证";
    el.handoffMainRisk.textContent = "--";
    el.handoffFocusMonths.textContent = "--";
    el.handoffTask.textContent = "待 M3-B 返回全年风险结论后，再进入最终工程定型。";
    return;
  }

  const annualJudgement = getAnnualJudgement(selectedAnnual);
  const annualMainRisk = getAnnualMainRisk(selectedAnnual);
  const annualM4Focus = getM4FocusText(selectedAnnual);

  let focusMonthsText = "无明显集中月份";

  if (selectedMonthly.length) {
    const monthlyUnmet = selectedMonthly.map((m) => Number(m.unmetTotal || 0));
    const monthlyService = selectedMonthly.map((m) => {
      const delivered = Number(m.deliveredEnergy || 0);
      const unmet = Number(m.unmetTotal || 0);
      const demand = delivered + unmet;
      return demand > 0 ? delivered / demand : 0;
    });
    const monthlyOverflow = selectedMonthly.map((m) => Number(m.overflowCount || 0));
    const monthlySoc = selectedMonthly.map((m) => Number(m.socMin ?? 100));

    const topRiskMonths = getTopRiskMonths(monthlyUnmet, monthlyService, monthlyOverflow, monthlySoc);
    focusMonthsText = topRiskMonths.length
      ? topRiskMonths.map((item) => item.label).join(" / ")
      : "无明显集中月份";
  }

  el.handoffJudgement.textContent = annualJudgement;
  el.handoffMainRisk.textContent = annualMainRisk;
  el.handoffFocusMonths.textContent = focusMonthsText;

  el.handoffSummary.textContent =
    annualJudgement === "全年表现基本稳健"
      ? `${selectedAnnualResult?.selectedRouteLabel || selectedRoute.label} 已完成全年验证，当前未暴露显著结构性年度风险。M4 将进一步完成方案对照与最终工程定型。`
      : `${selectedAnnualResult?.selectedRouteLabel || selectedRoute.label} 的全年验证表明仍存在 ${annualMainRisk}，风险主要集中于 ${focusMonthsText}。M4 将据此生成并比较最终工程方案。`;

  el.handoffTask.textContent = annualM4Focus;
}

function getM4ScenarioOptionLabel(scenario, recommendation) {
  const isRecommended =
    scenario.id === recommendation?.recommendedScenarioId;

  const recommendationMark = isRecommended ? " ★ 主推荐" : "";
  const title = scenario.variantLabel || scenario.title || "候选方案";

  return `${scenario.id}｜${title}${recommendationMark}`;
}

function getM4ScenarioTitle(scenario) {
  return (scenario?.variantLabel || scenario?.title || "候选方案").replace(/^S\d\s*/, "");
}

function getM4ScenarioBadges(scenario, recommendation) {
  const badges = [];
  if (scenario.id === recommendation?.recommendedScenarioId) badges.push("主推");
  if (scenario.id === recommendation?.lowInvestmentScenarioId) badges.push("低投");
  if (scenario.id === recommendation?.highProtectionScenarioId) badges.push("高保障");
  return badges.map((badge) => `<em>${badge}</em>`).join("");
}

function renderM4ScenarioDeltaCards(el, scenario, routeKey) {
  if (!scenario) {
    el.deltaPv.textContent = "-- kW";
    el.deltaStorage.textContent = "-- kWh";
    el.deltaPcs.textContent = "-- kW";
    el.deltaTransformer.textContent = "-- kW";
    el.deltaService.textContent = "--";
    return;
  }

  const d = scenario.deltas || {};

  el.deltaPv.textContent =
    `${formatNumber(d.deltaPvKw || 0, 1)} kW`;

  el.deltaStorage.textContent =
    `${formatNumber(d.deltaStorageKwh || 0, 1)} kWh`;

  el.deltaPcs.textContent =
    `${formatNumber(d.deltaPcsKw || 0, 1)} kW`;

  el.deltaTransformer.textContent =
    `${formatNumber(d.deltaTransformerKw || 0, 1)} kW`;

  el.deltaService.textContent =
    routeKey === "traditional_pile"
      ? `7kW +${d.deltaN7 || 0} / 30kW +${d.deltaN30 || 0}`
      : (() => {
          const deltaMatrix = d.deltaMatrix || 0;
          const deltaPMatrixKw = d.deltaPMatrixKw || 0;

          const parts = [];

          if (deltaMatrix > 0) {
            parts.push(`N_matrix +${deltaMatrix}`);
          }

          if (deltaPMatrixKw > 0) {
            parts.push(`P_matrix +${deltaPMatrixKw} kW`);
          }

          return parts.length > 0
            ? parts.join(" / ")
            : "N_matrix +0 / P_matrix +0 kW";
        })();
}

function renderM4InvestmentEffectChart(container, scenarios, recommendation) {
  if (!container || !Array.isArray(scenarios) || scenarios.length === 0) {
    resetInsightChart(container, "运行 M4 后展示方案投资与改善关系。");
    return;
  }

  const points = scenarios.map((scenario) => {
    const primaryRate = Number(
      scenario.familyEffectiveness?.primaryReductionRate ??
      scenario.improvementVsBaseline?.annual?.unmetReductionRate ??
      0
    );

    return {
      id: scenario.id,
      capex: Number(scenario.extraCapexWan || 0),
      effect: Math.max(0, Math.min(1, primaryRate || 0)),
      score: Number(scenario.recommendation?.totalScore || 0),
      isMain: scenario.id === recommendation?.recommendedScenarioId,
      isLow: scenario.id === recommendation?.lowInvestmentScenarioId,
      isSafe: scenario.id === recommendation?.highProtectionScenarioId
    };
  });

  const width = 640;
  const height = 320;
  const left = 64;
  const right = 24;
  const top = 28;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const maxCapex = Math.max(...points.map((p) => p.capex), 1);

  const pointSvg = points.map((point) => {
    const x = left + (point.capex / maxCapex) * plotWidth;
    const y = top + plotHeight - point.effect * plotHeight;

    const classes = [
      "scatter-point",
      point.isMain ? "main" : "",
      point.isLow ? "low" : "",
      point.isSafe ? "safe" : ""
    ].filter(Boolean).join(" ");

    const showLabel =
      point.id === "S0" ||
      point.isMain ||
      point.isLow ||
      point.isSafe;

    return `
      <g class="${classes}">
        <circle cx="${x}" cy="${y}" r="${point.isMain ? 8 : 6}">
          <title>
            ${point.id}｜追加投资 ${formatNumber(point.capex, 2)} 万｜主导改善率 ${formatNumber(point.effect * 100, 1)}%｜评分 ${formatNumber(point.score, 1)}
          </title>
        </circle>
        ${showLabel ? `<text x="${x + 10}" y="${y - 10}">${point.id}</text>` : ""}
      </g>
    `;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="M4 投资与风险改善关系图">
      <line class="scatter-axis" x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" />
      <line class="scatter-axis" x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}" />

      <line class="scatter-grid" x1="${left}" y1="${top}" x2="${left + plotWidth}" y2="${top}" />
      <line class="scatter-grid" x1="${left}" y1="${top + plotHeight / 2}" x2="${left + plotWidth}" y2="${top + plotHeight / 2}" />

      <text class="scatter-axis-label" x="10" y="${top + 4}">100%</text>
      <text class="scatter-axis-label" x="18" y="${top + plotHeight / 2 + 4}">50%</text>
      <text class="scatter-axis-label" x="26" y="${top + plotHeight + 4}">0%</text>

      <text class="scatter-axis-label" x="${left}" y="${height - 18}">0</text>
      <text class="scatter-axis-label" x="${left + plotWidth / 2 - 12}" y="${height - 18}">
        ${formatNumber(maxCapex / 2, 1)}
      </text>
      <text class="scatter-axis-label" x="${left + plotWidth - 28}" y="${height - 18}">
        ${formatNumber(maxCapex, 1)}
      </text>

      <text class="scatter-axis-title" x="${left + plotWidth / 2 - 54}" y="${height - 2}">
        追加投资（万元）
      </text>
      <text class="scatter-axis-title vertical" x="18" y="${top + plotHeight / 2 + 28}">
        主导风险改善率
      </text>

      ${pointSvg}
    </svg>

    <div class="scatter-legend">
      <span><i class="legend-dot main"></i>主推荐</span>
      <span><i class="legend-dot low"></i>低投资备选</span>
      <span><i class="legend-dot safe"></i>高保障备选</span>
    </div>
  `;
}

function renderM4BaselineCompareChart(container, scenarios, recommendation) {
  if (!container || !Array.isArray(scenarios) || scenarios.length === 0) {
    resetInsightChart(container, "运行 M4 后展示主推荐方案相对基准的改进。");
    return;
  }

  const baseline = scenarios.find((scenario) => scenario.id === "S0");
  const recommended = scenarios.find(
    (scenario) => scenario.id === recommendation?.recommendedScenarioId
  );

  if (!baseline || !recommended) {
    resetInsightChart(container, "缺少 S0 或主推荐方案，暂无法生成对比图。");
    return;
  }

  const rows = [
    {
      label: "全年总缺口",
      unit: "kWh",
      base: Number(baseline.annualValidation?.totalUnmetKwh || 0),
      rec: Number(recommended.annualValidation?.totalUnmetKwh || 0),
      better: "lower"
    },
    {
      label: "全年服务率",
      unit: "%",
      base: Number(baseline.annualValidation?.serviceRate || 0) * 100,
      rec: Number(recommended.annualValidation?.serviceRate || 0) * 100,
      better: "higher"
    },
    {
      label: "SOC 风险月份",
      unit: "月",
      base: Number(baseline.annualValidation?.monthsWithSocRisk || 0),
      rec: Number(recommended.annualValidation?.monthsWithSocRisk || 0),
      better: "lower"
    },
    {
      label: "全年越限次数",
      unit: "次",
      base: Number(baseline.annualValidation?.totalOverflowCount || 0),
      rec: Number(recommended.annualValidation?.totalOverflowCount || 0),
      better: "lower"
    }
  ];

  container.innerHTML = rows.map((row) => {
    const maxValue = Math.max(row.base, row.rec, 1);
    const baseWidth = Math.max(6, (row.base / maxValue) * 100);
    const recWidth = Math.max(6, (row.rec / maxValue) * 100);

    let deltaText = "持平";

    if (row.better === "lower") {
      if (row.base > 0) {
        const improveRate = ((row.base - row.rec) / row.base) * 100;
        if (improveRate > 0) {
          deltaText = `改善 ${formatNumber(improveRate, 1)}%`;
        } else if (improveRate < 0) {
          deltaText = `恶化 ${formatNumber(Math.abs(improveRate), 1)}%`;
        }
      }
    } else {
      const gain = row.rec - row.base;
      if (gain > 0) deltaText = `提升 ${formatNumber(gain, 1)} pct`;
      if (gain < 0) deltaText = `下降 ${formatNumber(Math.abs(gain), 1)} pct`;
    }

    return `
      <section class="baseline-compare-row">
        <div class="baseline-compare-head">
          <strong>${row.label}</strong>
          <em>${deltaText}</em>
        </div>

        <div class="baseline-bar-line">
          <span>S0</span>
          <div class="baseline-track">
            <div class="baseline-fill base" style="width:${baseWidth}%"></div>
          </div>
          <strong>${formatNumber(row.base, 1)} ${row.unit}</strong>
        </div>

        <div class="baseline-bar-line">
          <span>${recommended.id}</span>
          <div class="baseline-track">
            <div class="baseline-fill rec" style="width:${recWidth}%"></div>
          </div>
          <strong>${formatNumber(row.rec, 1)} ${row.unit}</strong>
        </div>
      </section>
    `;
  }).join("");
}

function renderM4Summary(state) {
  const result = state.stages.m4.result;
  const m3 = state.stages.m3.result;
  const selectedRouteKey = state.input.m3.selectedRoute;
  const el = dom.m4Summary;

  const selectedRoute = selectedRouteKey ? m3?.routeOptions?.[selectedRouteKey] : null;
  const selectedAnnualResult = m3?.selectedAnnualValidation || null;
  const selectedAnnual = selectedAnnualResult?.annualValidation || null;
  const selectedMonthly = selectedAnnualResult?.rawAnnual?.monthly || [];

  renderM4HandoffBridge(el, selectedRoute, selectedAnnualResult, selectedAnnual, selectedMonthly);

  if (selectedRoute) {
    el.selectedRoute.textContent = selectedRoute.label;
    el.residualUnmet.textContent = `${formatNumber(selectedRoute.handoffToM4?.residualUnmetKwh || 0, 1)} kWh`;
    el.residualQueue.textContent = `${formatNumber(selectedRoute.handoffToM4?.residualQueueUnmetKwh || 0, 1)} kWh`;
  } else {
    el.selectedRoute.textContent = "--";
    el.residualUnmet.textContent = "-- kWh";
    el.residualQueue.textContent = "-- kWh";
  }

  if (!result) {
    el.title.textContent = "M4 尚未运行。";
    el.meta.textContent = selectedAnnual
      ? "已承接 M3-B 全年验证结论，可以运行最终工程方案定型。"
      : selectedRoute
        ? "已选择技术路线，待 M3-B 全年验证完成后进入最终工程方案定型。"
        : "在 M3 选择路线并完成 M3-B 年度验证后运行最终工程方案定型。";
    el.residualSeverity.textContent = "--";
    el.recommendMain.textContent = "--";
    el.recommendLow.textContent = "--";
    el.recommendSafe.textContent = "--";
    el.recommendScore.textContent = "--";
    el.recommendExplain.textContent = "运行后，这里会解释为什么推荐该方案。";
    el.scenarioTableBody.innerHTML =
      '<tr><td colspan="8">M4 尚未运行。</td></tr>';

    if (el.scenarioSelect) {
      el.scenarioSelect.innerHTML =
        '<option value="">M4 尚未运行</option>';
      el.scenarioSelect.disabled = true;
      el.scenarioSelect.onchange = null;
    }

    renderM4ScenarioDeltaCards(el, null, selectedRouteKey);
    resetInsightChart(el.investmentEffectChart, "运行 M4 后展示方案投资与改善关系。");
    resetInsightChart(el.baselineCompareChart, "运行 M4 后展示主推荐方案相对基准的改进。");

    return;
  }

  const summary = result.summary || {};
  const diagnosis = result.residualDiagnosis || {};
  const recommendation = result.recommendation || {};
  const scenarios = result.scenarios || [];
  const recommended = scenarios.find((s) => s.id === recommendation.recommendedScenarioId) || scenarios[0];

  el.title.textContent = summary.title || "最终工程方案定型已完成";
  el.meta.textContent = `${summary.selectedRouteLabel || "--"} · 共评估 ${summary.scenarioCount || scenarios.length} 套方案` +
    (recommendation.feasibleCount != null ? ` · 硬可行 ${recommendation.feasibleCount} 套` : "");
  el.residualSeverity.textContent = `${diagnosis.severity || "--"} / ${formatNumber(diagnosis.severityScore || 0, 1)} · ${riskDiagnosisText(diagnosis)}`;
  el.recommendMain.textContent = recommended
    ? `${recommended.id} · ${getM4ScenarioTitle(recommended)}${recommendation.isFallbackRecommendation ? " (相对最优)" : ""}`
    : recommendation.recommendedScenarioId || "--";
  el.recommendLow.textContent = recommendation.lowInvestmentScenarioId || "--";
  el.recommendSafe.textContent = recommendation.highProtectionScenarioId || "--";
  el.recommendScore.textContent = recommended?.recommendation?.totalScore != null
    ? `${formatNumber(recommended.recommendation.totalScore, 1)} 分`
    : "--";
  el.recommendExplain.textContent = recommendation.explanation || "暂无推荐解释。";

  renderM4InvestmentEffectChart(
    el.investmentEffectChart,
    scenarios,
    recommendation
  );

  renderM4BaselineCompareChart(
    el.baselineCompareChart,
    scenarios,
    recommendation
  );


  el.scenarioTableBody.innerHTML = scenarios.map((scenario) => {
    const score = scenario.recommendation?.totalScore != null
      ? formatNumber(scenario.recommendation.totalScore, 1)
      : "--";
    const mark = scenario.id === recommendation.recommendedScenarioId ? " ★" : "";
    const rowClasses = [
      scenario.id === recommendation.recommendedScenarioId ? "recommended-row" : "",
      scenario.id === recommendation.lowInvestmentScenarioId ? "low-row" : "",
      scenario.id === recommendation.highProtectionScenarioId ? "safe-row" : ""
    ].filter(Boolean).join(" ");
    return `
      <tr class="${rowClasses}">
        <td>
          <strong>${scenario.id}${mark}</strong>
          <small>${getM4ScenarioTitle(scenario)}</small>
          <span class="scenario-badges">${getM4ScenarioBadges(scenario, recommendation)}</span>
        </td>
        <td>${formatNumber(scenario.extraCapexWan || 0, 2)} 万</td>
        <td>${formatNumber(scenario.annualValidation?.totalUnmetKwh || 0, 1)} kWh</td>
        <td>${scenario.annualValidation?.totalOverflowCount || 0}</td>
        <td>${formatNumber((scenario.evaluationIndicators?.pvur || 0) * 100, 1)}%</td>
        <td>${formatNumber(scenario.evaluationIndicators?.gff || 0, 3)}</td>
        <td>${formatNumber(scenario.evaluationIndicators?.annualLcoeYuanPerKwh || 0, 3)}</td>
        <td><span class="scenario-score">${score}</span></td>
      </tr>
    `;
  }).join("");

  const defaultScenarioId =
    recommendation.recommendedScenarioId ||
    recommended?.id ||
    scenarios[0]?.id ||
    "";

  const previousSelectedScenarioId =
    el.scenarioSelect?.value || "";

  const selectedScenarioId =
    scenarios.some((scenario) => scenario.id === previousSelectedScenarioId)
      ? previousSelectedScenarioId
      : defaultScenarioId;

  if (el.scenarioSelect) {
    el.scenarioSelect.innerHTML = scenarios.map((scenario) => {
      const selected =
        scenario.id === selectedScenarioId ? " selected" : "";

      return `
        <option value="${scenario.id}"${selected}>
          ${getM4ScenarioOptionLabel(scenario, recommendation)}
        </option>
      `;
    }).join("");

    el.scenarioSelect.disabled = scenarios.length === 0;

    el.scenarioSelect.onchange = () => {
      const scenario =
        scenarios.find((item) => item.id === el.scenarioSelect.value) ||
        recommended ||
        scenarios[0] ||
        null;

      renderM4ScenarioDeltaCards(
        el,
        scenario,
        summary.selectedRouteKey
      );
    };
  }

  const selectedScenario =
    scenarios.find((scenario) => scenario.id === selectedScenarioId) ||
    recommended ||
    scenarios[0] ||
    null;

  renderM4ScenarioDeltaCards(
    el,
    selectedScenario,
    summary.selectedRouteKey
  );
}

function renderReportBoard(state) {
  const el = dom.report;
  if (!el?.headline) return;

  const m1 = state.stages.m1.result;
  const m2 = state.stages.m2.result;
  const m3 = state.stages.m3.result;
  const m4 = state.stages.m4.result;
  const selectedAnnual = m3?.selectedAnnualValidation?.annualValidation || null;
  const recommendation = m4?.recommendation || null;
  const scenarios = m4?.scenarios || [];
  const recommended = scenarios.find((s) => s.id === recommendation?.recommendedScenarioId) || null;
  const annual = recommended?.annualValidation || selectedAnnual;

  if (m4 && recommendation) {
    el.headline.textContent = recommendation.isFallbackRecommendation
      ? "已有相对最优加固方案，仍需关注残余风险"
      : "已形成最终推荐方案，可进入汇报定稿";
    el.subtitle.textContent = recommendation.explanation || "推荐方案已结合投资、风险消除和年度运行表现综合排序。";
    el.action.textContent = recommendation.recommendedScenarioId || "--";
    el.actionNote.textContent = recommendation.isFallbackRecommendation ? "相对最优方案" : "主推荐方案";
  } else if (selectedAnnual) {
    el.headline.textContent = "年度验证已完成，建议进入 M4 加固定型";
    el.subtitle.textContent = `${getAnnualJudgement(selectedAnnual)}，主要关注：${getAnnualMainRisk(selectedAnnual)}。`;
    el.action.textContent = "运行 M4";
    el.actionNote.textContent = getM4FocusText(selectedAnnual);
  } else if (m3?.routeOptions) {
    el.headline.textContent = "调度路线已生成，先选择路线再做年度验证";
    el.subtitle.textContent = "完成价格调度评估后，选择传统桩站路线进入全年验证。";
    el.action.textContent = "选择 M3 路线";
    el.actionNote.textContent = "形成 M4 输入";
  } else if (m2?.riskReport) {
    el.headline.textContent = "压力风险已暴露，下一步评估调度消纳能力";
    el.subtitle.textContent = `压力月峰值 ${formatNumber(m2.riskReport.realPeakKw, 1)} kW，缺口 ${formatNumber(m2.riskReport.unmetTotalKwh, 1)} kWh。`;
    el.action.textContent = "运行 M3";
    el.actionNote.textContent = "比较调度路线";
  } else if (m1?.hardwarePlan) {
    el.headline.textContent = "基准建设规模已生成";
    el.subtitle.textContent = `${m1.summary.city} 基准方案：PV ${formatNumber(m1.hardwarePlan.pvKw, 1)} kW，储能 ${formatNumber(m1.hardwarePlan.storageKwh, 1)} kWh。`;
    el.action.textContent = "运行 M2";
    el.actionNote.textContent = "验证真实月风险";
  } else {
    el.headline.textContent = "等待 M1 规划结果";
    el.subtitle.textContent = "完成各阶段计算后，这里会自动汇总建设规模、年度风险和推荐方案。";
    el.action.textContent = "先运行 M1";
    el.actionNote.textContent = "建立基准配置";
  }

  const capexWan =
    recommended?.extraCapexWan != null && m1?.economics?.capexWan != null
      ? m1.economics.capexWan + recommended.extraCapexWan
      : m1?.economics?.capexWan;

  el.capex.textContent = Number.isFinite(capexWan) ? formatNumber(capexWan, 1) : "--";
  el.service.textContent = Number.isFinite(annual?.serviceRate)
    ? `${formatPercent(annual.serviceRate, 1)}%`
    : "--";
  el.riskMonths.textContent = annual
    ? `${annual.monthsWithSocRisk || 0} / ${annual.monthsWithOverflow || 0}`
    : "--";
}

export function renderApp(state) {
  const activeMeta = STAGES[state.activeStage];
  dom.stageTitle.textContent = activeMeta.title;
  dom.globalStatus.textContent = `${activeMeta.title} · ${getStageStatusLabel(state.stages[state.activeStage].status)}`;
  dom.summaryState.textContent = "状态中心已接管";
  dom.summaryWorker.textContent = state.workerStatus === "busy" ? "计算中" : state.workerStatus === "error" ? "异常" : "等待任务";
  dom.summaryUnlock.textContent = getUnlockedSummary(state);

  renderTabs(state);
  renderPanels(state);
  renderButtons(state);
  renderRawResults(state);
  renderReportBoard(state);
  renderM1Summary(state);
  renderM2Summary(state);
  renderM3Summary(state);
  renderM4Summary(state);

}
