// Cost forecasting.
//
// Every request already stores what it cost. This turns that history into an
// answer to the question people actually ask: "what is this going to cost me
// this month, and what is driving it?"
//
// Pure functions on purpose - the numbers are worth testing without a
// database.

const DAY_MS = 24 * 60 * 60 * 1000;

function toNumber(value) {
  const number = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function emptyBucket() {
  return { cost: 0, requests: 0 };
}

function addTo(bucket, row) {
  bucket.requests += 1;
  bucket.cost += toNumber(row.cost);
}

/**
 * @param {Array<{timestamp:string, provider:string, model:string, cost?:number}>} history
 * @param {{now?: Date}} options
 */
export function buildForecast(history, { now = new Date() } = {}) {
  const rows = Array.isArray(history) ? history : [];
  const today = startOfDay(now);
  const todayKey = dayKey(today);
  const sevenDaysAgo = today.getTime() - 6 * DAY_MS;
  const thirtyDaysAgo = today.getTime() - 29 * DAY_MS;

  const buckets = new Map();
  const providers = new Map();
  const models = new Map();
  const totals = {
    today: emptyBucket(),
    last7: emptyBucket(),
    last30: emptyBucket(),
    monthToDate: emptyBucket(),
  };

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let pricedRequests = 0;
  let requests = 0;

  for (const row of rows) {
    const timestamp = new Date(row.timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;
    requests += 1;
    const hasCost = row.cost !== null && row.cost !== undefined && toNumber(row.cost) > 0;
    if (hasCost) pricedRequests += 1;

    const key = dayKey(timestamp);
    if (!buckets.has(key)) buckets.set(key, emptyBucket());
    addTo(buckets.get(key), row);

    if (key === todayKey) addTo(totals.today, row);
    if (timestamp.getTime() >= sevenDaysAgo) addTo(totals.last7, row);
    if (timestamp.getTime() >= thirtyDaysAgo) addTo(totals.last30, row);
    if (timestamp.getTime() >= monthStart.getTime()) addTo(totals.monthToDate, row);

    if (timestamp.getTime() >= thirtyDaysAgo) {
      const provider = row.provider || "unknown";
      if (!providers.has(provider)) providers.set(provider, emptyBucket());
      addTo(providers.get(provider), row);

      const model = row.model || "unknown";
      if (!models.has(model)) models.set(model, emptyBucket());
      addTo(models.get(model), row);
    }
  }

  // The daily line: the last fourteen days, including the empty ones. A gap in
  // the line is a day you did not spend anything.
  const daily = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * DAY_MS);
    const key = dayKey(date);
    const bucket = buckets.get(key) || emptyBucket();
    daily.push({ date: key, cost: bucket.cost, requests: bucket.requests });
  }

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeftInMonth = Math.max(0, daysInMonth - now.getDate());
  const averageDailyCost = totals.last7.requests > 0 ? totals.last7.cost / 7 : 0;
  const projectedMonthEnd = totals.monthToDate.cost + averageDailyCost * daysLeftInMonth;

  const top = (map, limit) =>
    [...map.entries()]
      .map(([name, bucket]) => ({ name, cost: bucket.cost, requests: bucket.requests }))
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests)
      .slice(0, limit);

  const byProvider = top(providers, 8);
  const byModel = top(models, 8);
  const providerTotal = byProvider.reduce((sum, entry) => sum + entry.cost, 0);

  return {
    generatedAt: now.toISOString(),
    currency: "USD",
    totals: {
      today: totals.today,
      last7: totals.last7,
      last30: totals.last30,
      monthToDate: totals.monthToDate,
    },
    forecast: {
      averageDailyCost,
      daysLeftInMonth,
      projectedMonthEnd,
      monthToDate: totals.monthToDate.cost,
    },
    daily,
    byProvider,
    byModel,
    providerTotal,
    coverage: {
      requests,
      pricedRequests,
      // Requests without a price are the free tiers. They still cost tokens,
      // but not money.
      freeRequests: requests - pricedRequests,
    },
  };
}
