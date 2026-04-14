import { useEffect, useRef, useState } from "react";
import { ColorType, CrosshairMode, LineStyle, createChart } from "lightweight-charts";

function readRangeValue(valueOrFn) {
  if (typeof valueOrFn === "function") return Number(valueOrFn());
  return Number(valueOrFn);
}

function buildAutoscaleInfoProvider(minLinePrice, maxLinePrice) {
  return (original) => {
    const res = original();
    if (!res || !res.priceRange) return res;

    let minValue = readRangeValue(res.priceRange.minValue);
    let maxValue = readRangeValue(res.priceRange.maxValue);
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return res;

    if (Number.isFinite(minLinePrice)) minValue = Math.min(minValue, minLinePrice);
    if (Number.isFinite(maxLinePrice)) maxValue = Math.max(maxValue, maxLinePrice);

    const mid = (minValue + maxValue) / 2;
    const span = Math.max(0, maxValue - minValue);
    const minSpan = Math.max(Math.abs(mid) * 0.001, 0.05); // >= 0.1% or 0.05 USDC
    if (span < minSpan) {
      minValue = mid - minSpan / 2;
      maxValue = mid + minSpan / 2;
    }

    return {
      priceRange: { minValue, maxValue },
      margins: res.margins,
    };
  };
}

function sanitizeSeriesData(input) {
  const latestByTime = new Map();

  for (const item of input || []) {
    const time = Number(item?.time);
    const value = Number(item?.value);
    if (!Number.isFinite(time) || !Number.isFinite(value) || value <= 0) continue;
    latestByTime.set(time, { time, value });
  }

  const sorted = Array.from(latestByTime.values()).sort((a, b) => a.time - b.time);
  if (sorted.length <= 1) return sorted;

  const filtered = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const point = sorted[i];
    const prev = filtered[filtered.length - 1];
    const ratio = prev.value > 0 ? point.value / prev.value : 1;

    // Guard against malformed/mixed-scale points that cause fake "crash/spike" cliffs.
    if (Number.isFinite(ratio) && (ratio < 0.1 || ratio > 10)) {
      continue;
    }
    filtered.push(point);
  }

  return filtered;
}

export default function PriceChart({ data, priceLines = [], height = 340, labelFontSize = 18 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const overlaySeriesRef = useRef([]);
  const sizeRef = useRef({ width: 0, height: 0 });
  const rafRef = useRef(0);
  const [customLabels, setCustomLabels] = useState([]);

  function updateCustomLabels(lines = priceLines) {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) {
      setCustomLabels([]);
      return;
    }
    const next = [];
    for (const item of lines || []) {
      const label = String(item?.customLabel || "").trim();
      const value = Number(item?.value);
      if (!label || !Number.isFinite(value) || value <= 0) continue;
      const y = series.priceToCoordinate(value);
      if (!Number.isFinite(y)) continue;
      const position = String(item?.customLabelPosition || "above").toLowerCase();
      const customOffset = Number(item?.customLabelOffset);
      const offset = Number.isFinite(customOffset) ? customOffset : position === "below" ? 18 : -18;
      next.push({
        key: `${label}-${value}`,
        text: label,
        top: y + offset,
        color: item.color || "#94b6ae",
        position,
        size: String(item?.customLabelSize || "").toLowerCase(),
      });
    }
    setCustomLabels(next);
  }

  function refitChart() {
    if (!chartRef.current) return;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(() => {
      chartRef.current?.timeScale().fitContent();
      rafRef.current = 0;
    });
  }

  useEffect(() => {
    if (!containerRef.current) return;
    const initialWidth = containerRef.current.clientWidth || 800;
    const initialHeight = containerRef.current.clientHeight || height || 340;
    sizeRef.current = { width: initialWidth, height: initialHeight };

    const chart = createChart(containerRef.current, {
      width: initialWidth,
      height: initialHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#b6d7d1",
        fontFamily: "Space Grotesk, sans-serif",
        fontSize: Number(labelFontSize || 18),
      },
      rightPriceScale: {
        borderVisible: false
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 0,
        fixLeftEdge: true,
        fixRightEdge: true
      },
      grid: {
        horzLines: { color: "rgba(123, 163, 153, 0.18)", style: LineStyle.Dotted },
        vertLines: { color: "rgba(123, 163, 153, 0.08)", style: LineStyle.Dotted }
      },
      crosshair: {
        mode: CrosshairMode.Normal
      }
    });

    const series = chart.addAreaSeries({
      lineColor: "#18d6b0",
      topColor: "rgba(24, 214, 176, 0.35)",
      bottomColor: "rgba(24, 214, 176, 0.02)",
      lineWidth: 2,
      autoscaleInfoProvider: buildAutoscaleInfoProvider(NaN, NaN),
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        const width = containerRef.current.clientWidth || 0;
        const height = containerRef.current.clientHeight || 0;
        const last = sizeRef.current;
        if (width === 0 || height === 0) return;
        if (last.width === width && last.height === height) return;
        sizeRef.current = { width, height };
        chart.applyOptions({
          width,
          height
        });
        updateCustomLabels();
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      resizeObserver.disconnect();
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !containerRef.current) return;
    const width = containerRef.current.clientWidth || sizeRef.current.width || 800;
    const nextHeight = Number(height || 340);
    sizeRef.current = { width, height: nextHeight };
    chartRef.current.applyOptions({
      width,
      height: nextHeight,
    });
    updateCustomLabels();
    refitChart();
  }, [height]);

  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      layout: {
        fontSize: Number(labelFontSize || 18),
      },
    });
  }, [labelFontSize]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    const next = sanitizeSeriesData(data);
    seriesRef.current.setData(next);
    updateCustomLabels();
    if (next.length > 1) {
      refitChart();
    }
  }, [data]);

  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return;
    for (const item of overlaySeriesRef.current) {
      try {
        seriesRef.current.removePriceLine(item);
      } catch {
      }
    }
    overlaySeriesRef.current = [];

    let minLinePrice = Infinity;
    let maxLinePrice = -Infinity;

    for (const item of priceLines || []) {
      const value = Number(item?.value);
      if (!Number.isFinite(value) || value <= 0) continue;
      
      minLinePrice = Math.min(minLinePrice, value);
      maxLinePrice = Math.max(maxLinePrice, value);

      const priceLine = seriesRef.current.createPriceLine({
        price: value,
        color: item.color || "#94b6ae",
        lineWidth: Number(item.lineWidth || 1),
        lineStyle: item.lineStyle || LineStyle.Solid,
        axisLabelVisible: item.axisLabelVisible !== false,
        title: item.title || "",
      });
      overlaySeriesRef.current.push(priceLine);
    }

    const useMinLine = minLinePrice !== Infinity ? minLinePrice : NaN;
    const useMaxLine = maxLinePrice !== -Infinity ? maxLinePrice : NaN;
    seriesRef.current.applyOptions({
      autoscaleInfoProvider: buildAutoscaleInfoProvider(useMinLine, useMaxLine),
    });
    updateCustomLabels(priceLines);
  }, [priceLines]);

  return (
    <div className="chart-shell-wrap" style={{ width: "100%", height: `${height}px`, minHeight: `${height}px`, maxHeight: `${height}px` }}>
      <div className="chart-shell" ref={containerRef} style={{ width: "100%", height: `${height}px`, minHeight: `${height}px`, maxHeight: `${height}px` }} />
      {customLabels.map((label) => (
        <div
          key={label.key}
          className={`chart-custom-label ${label.size === "small" ? "chart-custom-label-small" : ""}`}
          style={{
            top: `${label.top}px`,
            color: label.color,
          }}
        >
          {label.text}
        </div>
      ))}
    </div>
  );
}
