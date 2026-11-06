// Statistics for comparing today's temperature with the same date in past years.
// Pure functions only: no DOM, no network. See CLAUDE.md → "Statistics".

const RECENT_YEARS = 15;          // "last 15 years" for the trend description
const BASELINE = [1951, 1980];    // earlier reference period for the trend description
const SIMILAR_THRESHOLD = 0.5;    // °C; smaller changes are described as "similar"
const WINDOW_DAYS = 7;            // ±7 days, used only for the trend description
const MIN_WINDOW_DAYS = 10;       // a year needs at least 10 of the 15 window days

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Turn Open-Meteo's parallel arrays into a Map of "YYYY-MM-DD" → number (nulls dropped). */
export function toMap(dates, values) {
  const map = new Map();
  dates.forEach((date, i) => {
    const v = values[i];
    if (v !== null && v !== undefined && !Number.isNaN(v)) map.set(date, v);
  });
  return map;
}

/** The date to use in a given year for a target month/day (29 Feb → 28 Feb in non-leap years). */
export function dateInYear(year, month, day) {
  if (month === 2 && day === 29 && !isLeap(year)) return iso(year, 2, 28);
  return iso(year, month, day);
}

/**
 * Values on the same calendar date in each year from firstYear to lastYear.
 * Missing years are skipped. Returns [{ year, value }].
 */
export function sameDateSeries(map, month, day, firstYear, lastYear) {
  const out = [];
  for (let y = firstYear; y <= lastYear; y++) {
    const v = map.get(dateInYear(y, month, day));
    if (v !== undefined) out.push({ year: y, value: v });
  }
  return out;
}

/** Per-year mean over ±WINDOW_DAYS around the target date (trend description only). */
export function windowSeries(map, month, day, firstYear, lastYear, half = WINDOW_DAYS) {
  const out = [];
  for (let y = firstYear; y <= lastYear; y++) {
    const [yy, mm, dd] = dateInYear(y, month, day).split('-').map(Number);
    const centre = Date.UTC(yy, mm - 1, dd);
    const vals = [];
    for (let k = -half; k <= half; k++) {
      const d = new Date(centre + k * 86400000);
      const v = map.get(iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
      if (v !== undefined) vals.push(v);
    }
    if (vals.length >= MIN_WINDOW_DAYS) out.push({ year: y, value: mean(vals) });
  }
  return out;
}

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Share (0–100) of historical values strictly below x. */
export function percentile(values, x) {
  return (values.filter((v) => v < x).length / values.length) * 100;
}

/** Rank of x among values plus x itself, 1 = warmest. Ties share the better rank. */
export function rank(values, x) {
  return { rank: values.filter((v) => v > x).length + 1, of: values.length + 1 };
}

export function label(p) {
  if (p < 10) return 'unusually cold';
  if (p < 25) return 'cooler than usual';
  if (p <= 75) return 'typical';
  if (p <= 90) return 'warmer than usual';
  return 'unusually warm';
}

/** Least-squares slope of value against year, in °C per decade. */
export function trendPerDecade(points) {
  const n = points.length;
  if (n < 2) return 0;
  const mx = mean(points.map((p) => p.year));
  const my = mean(points.map((p) => p.value));
  let num = 0, den = 0;
  for (const p of points) {
    num += (p.year - mx) * (p.value - my);
    den += (p.year - mx) ** 2;
  }
  return den === 0 ? 0 : (num / den) * 10;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const fmt = (x) => x.toFixed(1);
const signed = (x) => `${fmt(Math.abs(x))} °C ${x >= 0 ? 'above' : 'below'}`;

/** Statistics for one metric (high or low) on the exact date. */
export function compare(series, todayValue) {
  const values = series.map((p) => p.value);
  const p = percentile(values, todayValue);
  const avg = mean(values);
  return {
    percentile: p,
    label: label(p),
    ...rank(values, todayValue),
    mean: avg,
    diff: todayValue - avg,
    years: values.length,
    firstYear: series[0]?.year,
    lastYear: series[series.length - 1]?.year,
  };
}

/** Trend numbers for one metric from the ±7-day window series. */
export function trend(series) {
  if (series.length < RECENT_YEARS * 2) return null;
  const last = series[series.length - 1].year;
  const inRange = (a, b) => series.filter((p) => p.year >= a && p.year <= b).map((p) => p.value);
  const recent = inRange(last - RECENT_YEARS + 1, last);
  const previous = inRange(last - 2 * RECENT_YEARS + 1, last - RECENT_YEARS);
  const baseline = inRange(BASELINE[0], BASELINE[1]);
  return {
    recentRange: [last - RECENT_YEARS + 1, last],
    recentMean: mean(recent),
    vsPrevious: mean(recent) - mean(previous),
    vsBaseline: baseline.length ? mean(recent) - mean(baseline) : null,
    perDecade: trendPerDecade(series),
  };
}

const change = (d) =>
  Math.abs(d) < SIMILAR_THRESHOLD
    ? 'about the same as'
    : `about ${fmt(Math.abs(d))} °C ${d > 0 ? 'warmer than' : 'cooler than'}`;

export const dateLabel = (month, day) => `${day} ${MONTHS[month - 1]}`;

/**
 * Build everything the page needs for one city.
 * history: { time: [...], temperature_2m_max: [...], temperature_2m_min: [...] } (Open-Meteo daily)
 * today:   { date: "YYYY-MM-DD", max: number, min: number, isForecast: boolean }
 */
export function analyse({ city, history, today }) {
  const [ty, tm, td] = today.date.split('-').map(Number);
  const maxMap = toMap(history.time, history.temperature_2m_max);
  const minMap = toMap(history.time, history.temperature_2m_min);
  const firstYear = Number(history.time[0].slice(0, 4));
  const lastYear = ty - 1;

  const highSeries = sameDateSeries(maxMap, tm, td, firstYear, lastYear);
  const lowSeries = sameDateSeries(minMap, tm, td, firstYear, lastYear);
  const high = compare(highSeries, today.max);
  const low = compare(lowSeries, today.min);

  const highTrend = trend(windowSeries(maxMap, tm, td, firstYear, lastYear));
  const lowTrend = trend(windowSeries(minMap, tm, td, firstYear, lastYear));

  const when = dateLabel(tm, td);
  const dayWord = today.isForecast ? "Today's" : "Yesterday's";
  const nightWord = today.isForecast ? "Tonight's" : "Yesterday's";

  const summary = [
    `${dayWord} high of ${fmt(today.max)} °C in ${city} is in the ${ordinal(Math.round(high.percentile))} percentile ` +
      `for ${when} since ${high.firstYear} (${ordinal(high.rank)} warmest of ${high.of}, ` +
      `${signed(high.diff)} the long-term average of ${fmt(high.mean)} °C): ${high.label}.`,
    `${nightWord} low of ${fmt(today.min)} °C is in the ${ordinal(Math.round(low.percentile))} percentile, ` +
      `${signed(low.diff)} average: ${low.label}.`,
    `Based on ${high.years} years of data (${high.firstYear}–${high.lastYear}).`,
  ];

  let trendText = [];
  if (highTrend && lowTrend) {
    const [a, b] = highTrend.recentRange;
    trendText = [
      `Over the last ${RECENT_YEARS} years (${a}–${b}), highs around ${when} in ${city} were ` +
        `${change(highTrend.vsPrevious)} the ${RECENT_YEARS} years before, and lows were ${change(lowTrend.vsPrevious)}.`,
      highTrend.vsBaseline !== null
        ? `Compared with ${BASELINE[0]}–${BASELINE[1]}, highs are ${change(highTrend.vsBaseline)} and lows are ${change(lowTrend.vsBaseline)}.`
        : '',
      `Since ${high.firstYear}, highs have changed by ${highTrend.perDecade >= 0 ? '+' : '−'}${fmt(Math.abs(highTrend.perDecade))} °C ` +
        `and lows by ${lowTrend.perDecade >= 0 ? '+' : '−'}${fmt(Math.abs(lowTrend.perDecade))} °C per decade ` +
        `(trend based on the week either side of ${when}).`,
    ].filter(Boolean);
  }

  return { high, low, highSeries, lowSeries, highTrend, lowTrend, summary, trendText };
}
