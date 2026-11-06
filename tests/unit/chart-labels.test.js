// The provider chart puts one bar per provider on the canvas, and the value
// of every bar is written above it. Thirty providers means thirty numbers in
// the width of one card, so the placement has to keep them apart.
import { describe, it, expect } from "vitest";
import { layoutValueLabels, labelsOverlap, CHART_GEOMETRY } from "../../src/lib/chartLabels.js";

// A monospace-ish measurer: every character is the same width.
const measure = (text) => text.length * 6;

function build(values, width = 560) {
  const rows = values.map((value, index) => ({
    index,
    value,
    label: value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : String(value),
  }));
  const maxValue = Math.max(...values, 0);
  return layoutValueLabels(rows, { width, fontFamily: "sans-serif", maxValue, measure });
}

describe("chart value labels", () => {
  it("never lets two labels cover each other", () => {
    // One huge provider and a long tail of small ones - the case that broke
    // the chart before.
    const values = [1155700000, 63900000, 21200000, 7600000, 6000000, 3000000, 1500000, 1100000];
    for (let i = 0; i < 25; i++) values.push(0);

    const labels = build(values);
    expect(labels).toHaveLength(values.length);

    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        expect(labelsOverlap(labels[i], labels[j])).toBe(false);
      }
    }
  });

  it("keeps every label inside the chart", () => {
    const values = [1155700000, 63900000, 0, 0, 0, 0, 0, 0, 0, 0];
    const labels = build(values);
    const top = CHART_GEOMETRY.margin.top;
    const bottom = CHART_GEOMETRY.height - CHART_GEOMETRY.margin.bottom;

    for (const label of labels) {
      expect(label.y).toBeGreaterThanOrEqual(top);
      expect(label.y).toBeLessThanOrEqual(bottom);
    }
  });

  it("puts the biggest value at the top and the small ones near the baseline", () => {
    const labels = build([1155700000, 63900000, 21200000]);
    const tallest = labels[0];
    const smallest = labels[2];

    expect(tallest.y).toBeLessThan(smallest.y);
    // The tall bar keeps the slot right above it, the small one sits low.
    expect(smallest.y).toBeGreaterThan(
      CHART_GEOMETRY.height - CHART_GEOMETRY.margin.bottom - 20
    );
  });

  it("centres every label on its own bar", () => {
    const values = [10, 20, 30, 40];
    const labels = build(values);
    const plotLeft = CHART_GEOMETRY.margin.left + CHART_GEOMETRY.yAxisWidth;
    const plotWidth = 560 - plotLeft - CHART_GEOMETRY.margin.right;
    const band = plotWidth / values.length;

    labels.forEach((label, index) => {
      expect(label.x).toBeCloseTo(plotLeft + band * (index + 0.5), 6);
    });
  });

  it("returns nothing without a width to lay out", () => {
    expect(layoutValueLabels([], { width: 500, maxValue: 1 })).toEqual([]);
    expect(layoutValueLabels([{ index: 0, value: 1, label: "1" }], { width: 0, maxValue: 1 })).toEqual([]);
  });
});
