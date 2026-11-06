// Placing the value labels of a bar chart.
//
// One bar per provider means a chart can hold thirty providers, and the
// numbers of the small ones all end up on the same line near the baseline.
// The labels are therefore placed by hand: the tallest bar keeps the slot
// right above it and every other label is pushed one row up until it no
// longer covers a label that is already there.
//
// The geometry lives here so the chart and the labels cannot drift apart.

export const CHART_GEOMETRY = {
  height: 250,
  margin: { top: 30, right: 8, left: 0, bottom: 8 },
  yAxisWidth: 44,
  barCategoryGap: 0.18,
};

export const LABEL_FONT_SIZE = 9;
export const LABEL_LINE_HEIGHT = 11;
const LABEL_PADDING = 2;
const LABEL_HEADROOM = 8;
const MAX_LABEL_LEVELS = 12;

// Default measurer: the browser can measure text exactly, a test cannot.
export function measureWithCanvas(text, fontFamily) {
  if (typeof document === "undefined") return text.length * 5.4;
  if (!measureWithCanvas.context) {
    measureWithCanvas.context = document.createElement("canvas").getContext("2d");
  }
  const context = measureWithCanvas.context;
  context.font = `${LABEL_FONT_SIZE}px ${fontFamily || "sans-serif"}`;
  return context.measureText(text).width;
}

/**
 * @param {Array<{index:number, value:number, label:string}>} rows
 * @param {{width:number, fontFamily?:string, maxValue:number, measure?:Function}} options
 * @returns {Array<{x:number, y:number, text:string, width:number}>}
 */
export function layoutValueLabels(rows, options) {
  const { width, fontFamily, maxValue } = options;
  const measure = options.measure || ((text) => measureWithCanvas(text, fontFamily));
  const count = rows.length;
  if (!count || !width) return [];

  const { margin, yAxisWidth, height } = CHART_GEOMETRY;
  const plotLeft = margin.left + yAxisWidth;
  const plotWidth = Math.max(width - plotLeft - margin.right, 1);
  const plotTop = margin.top;
  const plotBottom = height - margin.bottom;
  const plotHeight = Math.max(plotBottom - plotTop, 1);
  const band = plotWidth / count;
  const domainMax = (maxValue || 1) * 1.15;

  const labels = rows.map((row) => ({
    text: row.label,
    x: plotLeft + band * (row.index + 0.5),
    barTop: plotBottom - (Math.max(row.value || 0, 0) / domainMax) * plotHeight,
    width: measure(row.label) + LABEL_PADDING * 2,
    y: null,
  }));

  // The tallest bar is placed first: it owns the slot above itself, and the
  // smaller bars climb around it.
  const placed = [];
  const order = labels
    .map((_, index) => index)
    .sort((a, b) => labels[a].barTop - labels[b].barTop);

  for (const index of order) {
    const label = labels[index];
    let y = null;
    for (let level = 0; level < MAX_LABEL_LEVELS; level++) {
      const candidate = label.barTop - 5 - level * LABEL_LINE_HEIGHT;
      if (candidate < plotTop + LABEL_HEADROOM) break;
      const clash = placed.some(
        (other) =>
          Math.abs(other.x - label.x) < (other.width + label.width) / 2 &&
          Math.abs(other.y - candidate) < LABEL_LINE_HEIGHT - 2
      );
      if (!clash) {
        y = candidate;
        break;
      }
    }
    if (y === null) y = Math.max(label.barTop - 5, plotTop + LABEL_HEADROOM);
    label.y = y;
    placed.push(label);
  }

  return labels;
}

// True when two labels cover each other. Used by the tests and by the
// component as a guard before it renders.
export function labelsOverlap(a, b) {
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
    Math.abs(a.y - b.y) < LABEL_LINE_HEIGHT - 2
  );
}
