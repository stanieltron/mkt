import { useEffect, useRef } from "react";
import { ColorType, CrosshairMode, LineStyle, createChart } from "lightweight-charts";

function sanitizeSeriesData(input) {
  const latestByTime = new Map();

  for (const item of input || []) {
    const time = Number(item?.time);
    const value = Number(item?.value);
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
    latestByTime.set(time, { time, value });
  }

  return Array.from(latestByTime.values()).sort((a, b) => a.time - b.time);
}

export default function PriceChart({ data, priceLines = [], height = 340 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const overlaySeriesRef = useRef([]);
  const sizeRef = useRef({ width: 0, height: 0 });
  const rafRef = useRef(0);

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
        fontFamily: "Space Grotesk, sans-serif"
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
      lineWidth: 2
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
    refitChart();
  }, [height]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    const next = sanitizeSeriesData(data);
    seriesRef.current.setData(next);
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

    if (minLinePrice !== Infinity && maxLinePrice !== -Infinity) {
      seriesRef.current.applyOptions({
        autoscaleInfoProvider: (original) => {
          const res = original();
          if (res && res.priceRange) {
            const baseMin = typeof res.priceRange.minValue === "function" ? res.priceRange.minValue() : res.priceRange.minValue;
            const baseMax = typeof res.priceRange.maxValue === "function" ? res.priceRange.maxValue() : res.priceRange.maxValue;
            return {
              priceRange: {
                minValue: Math.min(baseMin, minLinePrice),
                maxValue: Math.max(baseMax, maxLinePrice),
              },
              margins: res.margins,
            };
          }
          return res;
        }
      });
    } else {
      seriesRef.current.applyOptions({
        autoscaleInfoProvider: undefined,
      });
    }
  }, [priceLines]);

  return <div className="chart-shell" ref={containerRef} style={{ width: "100%", height: `${height}px`, minHeight: `${height}px`, maxHeight: `${height}px` }} />;
}
