// The forecast turns request history into "what will this month cost". The
// numbers have to add up on their own, so they are tested without a database.
import { describe, it, expect } from "vitest";
import { buildForecast } from "../../src/lib/usageForecast.js";

const NOW = new Date(2026, 10, 15, 12, 0, 0); // 15 November 2026, local time

const row = (date, provider, model, cost) => ({
  timestamp: new Date(date.getTime()).toISOString(),
  provider,
  model,
  cost,
});

const HISTORY = [
  row(new Date(2026, 10, 15, 9, 0, 0), "openai", "gpt-5", 2),
  row(new Date(2026, 10, 13, 9, 0, 0), "groq", "llama", 0), // free tier
  row(new Date(2026, 10, 12, 9, 0, 0), "openai", "gpt-5", 3),
  row(new Date(2026, 10, 5, 9, 0, 0), "openai", "gpt-5", 4),
  row(new Date(2026, 9, 6, 9, 0, 0), "openai", "gpt-5", 100), // older than 30 days
];

describe("cost forecast", () => {
  it("counts today, the last 7 days, the last 30 days and the month", () => {
    const { totals } = buildForecast(HISTORY, { now: NOW });

    expect(totals.today).toEqual({ cost: 2, requests: 1 });
    expect(totals.last7).toEqual({ cost: 5, requests: 3 });
    expect(totals.last30).toEqual({ cost: 9, requests: 4 });
    expect(totals.monthToDate).toEqual({ cost: 9, requests: 4 });
  });

  it("projects the end of the month from the last 7 days", () => {
    const { forecast } = buildForecast(HISTORY, { now: NOW });

    expect(forecast.daysLeftInMonth).toBe(15);
    expect(forecast.averageDailyCost).toBeCloseTo(5 / 7, 6);
    expect(forecast.projectedMonthEnd).toBeCloseTo(9 + (5 / 7) * 15, 6);
    expect(forecast.monthToDate).toBe(9);
  });

  it("separates the free tiers from the paid ones", () => {
    const { coverage } = buildForecast(HISTORY, { now: NOW });

    expect(coverage.requests).toBe(5);
    expect(coverage.pricedRequests).toBe(4);
    expect(coverage.freeRequests).toBe(1);
  });

  it("ranks the providers by what they cost in the last 30 days", () => {
    const { byProvider } = buildForecast(HISTORY, { now: NOW });

    expect(byProvider[0]).toEqual({ name: "openai", cost: 9, requests: 3 });
    expect(byProvider[1]).toEqual({ name: "groq", cost: 0, requests: 1 });
  });

  it("returns fourteen days of history, gaps included", () => {
    const { daily } = buildForecast(HISTORY, { now: NOW });

    expect(daily).toHaveLength(14);
    expect(daily[daily.length - 1]).toEqual({ date: "2026-11-15", cost: 2, requests: 1 });
    expect(daily.find((day) => day.date === "2026-11-14")).toEqual({
      date: "2026-11-14",
      cost: 0,
      requests: 0,
    });
  });

  it("survives an empty or broken history", () => {
    const empty = buildForecast([], { now: NOW });
    expect(empty.totals.today).toEqual({ cost: 0, requests: 0 });
    expect(empty.forecast.projectedMonthEnd).toBe(0);
    expect(empty.daily).toHaveLength(14);

    const broken = buildForecast([{ timestamp: "not a date", cost: 5 }], { now: NOW });
    expect(broken.coverage.requests).toBe(0);
  });
});
