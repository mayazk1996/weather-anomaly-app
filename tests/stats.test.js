import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMap, dateInYear, sameDateSeries, windowSeries, percentile, rank, label,
  trendPerDecade, ordinal, analyse, trendSentences,
} from '../src/stats.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// Synthetic daily history: value = base + slope·(year − 1940), no noise.
function makeHistory(firstYear, lastYear, fn) {
  const time = [], max = [], min = [];
  for (let t = Date.UTC(firstYear, 0, 1); t <= Date.UTC(lastYear, 11, 31); t += 86400000) {
    const d = new Date(t);
    const s = d.toISOString().slice(0, 10);
    time.push(s);
    const { hi, lo } = fn(d.getUTCFullYear(), s);
    max.push(hi);
    min.push(lo);
  }
  return { time, temperature_2m_max: max, temperature_2m_min: min };
}

test('toMap drops nulls', () => {
  const m = toMap(['2020-01-01', '2020-01-02'], [1.5, null]);
  assert.equal(m.size, 1);
  assert.equal(m.get('2020-01-01'), 1.5);
});

test('29 February uses 28 February in non-leap years', () => {
  assert.equal(dateInYear(2024, 2, 29), '2024-02-29');
  assert.equal(dateInYear(2023, 2, 29), '2023-02-28');
  assert.equal(dateInYear(1900, 2, 29), '1900-02-28');
  assert.equal(dateInYear(2000, 2, 29), '2000-02-29');
});

test('sameDateSeries picks the exact date and skips missing years', () => {
  const m = toMap(['2020-11-05', '2020-11-06', '2022-11-05'], [10, 99, 12]);
  assert.deepEqual(sameDateSeries(m, 11, 5, 2020, 2022), [
    { year: 2020, value: 10 },
    { year: 2022, value: 12 },
  ]);
});

test('percentile is the share strictly below', () => {
  assert.equal(percentile([1, 2, 3, 4], 3.5), 75);
  assert.equal(percentile([1, 2, 3, 4], 0), 0);
  assert.equal(percentile([1, 2, 3, 4], 9), 100);
  assert.equal(percentile([1, 2, 3, 4], 3), 50);
});

test('rank counts today among all years, 1 = warmest', () => {
  assert.deepEqual(rank([1, 2, 3, 4], 3.5), { rank: 2, of: 5 });
  assert.deepEqual(rank([1, 2, 3, 4], 9), { rank: 1, of: 5 });
});

test('labels follow the agreed bands', () => {
  assert.equal(label(5), 'unusually cold');
  assert.equal(label(20), 'cooler than usual');
  assert.equal(label(50), 'typical');
  assert.equal(label(80), 'warmer than usual');
  assert.equal(label(95), 'unusually warm');
});

test('trendPerDecade recovers a known slope', () => {
  const pts = Array.from({ length: 50 }, (_, i) => ({ year: 1970 + i, value: 5 + 0.03 * i }));
  close(trendPerDecade(pts), 0.3, 1e-9);
});

test('windowSeries averages ±7 days and crosses the year boundary', () => {
  const h = makeHistory(2019, 2021, (y) => ({ hi: y, lo: 0 }));
  const m = toMap(h.time, h.temperature_2m_max);
  const s = windowSeries(m, 1, 3, 2020, 2020);
  // 3 Jan 2020 ±7 days: 5 days in Dec 2019, 10 days in Jan 2020.
  close(s[0].value, (5 * 2019 + 10 * 2020) / 15);
});

test('ordinal suffixes', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 82, 101].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '82nd', '101st']);
});

test('analyse end to end on a warming synthetic city', () => {
  // Highs warm by 0.2 °C/decade, lows by 0.3 °C/decade.
  const history = makeHistory(1940, 2025, (y) => ({
    hi: 10 + 0.02 * (y - 1940),
    lo: 2 + 0.03 * (y - 1940),
  }));
  const r = analyse({
    city: 'Testville',
    history,
    today: { date: '2026-11-05', max: 50, min: -50, isForecast: true },
  });
  assert.equal(r.high.years, 86);
  assert.equal(r.high.percentile, 100);
  assert.equal(r.high.rank, 1);
  assert.equal(r.high.of, 87);
  assert.equal(r.low.percentile, 0);
  assert.equal(r.low.label, 'unusually cold');
  close(r.highTrend.perDecade, 0.2, 1e-6);
  close(r.lowTrend.perDecade, 0.3, 1e-6);
  assert.match(r.summary[0], /^Today's high of 50\.0 °C in Testville is in the 100th percentile for 5 November since 1940 \(1st warmest of 87/);
  assert.match(r.summary[1], /^Tonight's low of -50\.0 °C is in the 0th percentile/);
  assert.match(r.trendText.join(' '), /similar to 1996–2010/);
  assert.match(r.trendText.join(' '), /\+0\.2 °C and lows by \+0\.3 °C per decade/);
});

test('analyse labels yesterday when not a forecast', () => {
  const history = makeHistory(1940, 2025, () => ({ hi: 10, lo: 0 }));
  const r = analyse({
    city: 'X', history,
    today: { date: '2026-01-10', max: 10, min: 0, isForecast: false },
  });
  assert.match(r.summary[0], /^Yesterday's high/);
});

// --- Trend sentences: check the exact wording so incomplete phrases can't come back. ---

const ranges = { recentRange: [2011, 2025], previousRange: [1996, 2010] };
const tr = (vsPrevious, vsBaseline, perDecade) => ({ ...ranges, vsPrevious, vsBaseline, perDecade });
const sentences = (highTrend, lowTrend) =>
  trendSentences({ city: 'Berlin', when: '7 November', firstYear: 1940, highTrend, lowTrend });

test('trend sentences: both halves are complete when warmer', () => {
  assert.deepEqual(sentences(tr(1.5, 2.2, 0.4), tr(0.7, 1.4, 0.3)), [
    'Over the last 15 years (2011–2025), highs around 7 November in Berlin were about 1.5 °C warmer than in 1996–2010, and lows about 0.7 °C warmer.',
    'Highs are about 2.2 °C warmer than in 1951–1980, and lows about 1.4 °C warmer.',
    'Since 1940, highs have changed by +0.4 °C and lows by +0.3 °C per decade (trend based on the week either side of 7 November).',
  ]);
});

test('trend sentences: cooler is worded as cooler, with a minus sign for the decade trend', () => {
  const [first, , third] = sentences(tr(-1.2, -0.9, -0.1), tr(-0.6, -0.7, -0.2));
  assert.equal(first, 'Over the last 15 years (2011–2025), highs around 7 November in Berlin were about 1.2 °C cooler than in 1996–2010, and lows about 0.6 °C cooler.');
  assert.match(third, /highs have changed by −0\.1 °C and lows by −0\.2 °C per decade/);
});

test('trend sentences: changes under 0.5 °C read "similar to"', () => {
  const [first, second] = sentences(tr(0.3, 0.49, 0.1), tr(-0.2, 0.1, 0.0));
  assert.equal(first, 'Over the last 15 years (2011–2025), highs around 7 November in Berlin were similar to 1996–2010, and lows similar.');
  assert.equal(second, 'Highs are similar to 1951–1980, and lows similar.');
});

test('trend sentences: exactly 0.5 °C counts as a real change; mixed halves stay complete', () => {
  const [first] = sentences(tr(0.2, 0.2, 0.1), tr(0.5, 0.5, 0.1));
  assert.equal(first, 'Over the last 15 years (2011–2025), highs around 7 November in Berlin were similar to 1996–2010, and lows about 0.5 °C warmer.');
});

test('trend sentences: baseline sentence is dropped when 1951–1980 data is missing', () => {
  const out = sentences(tr(1.0, null, 0.2), tr(1.0, null, 0.2));
  assert.equal(out.length, 2);
  assert.match(out[1], /^Since 1940/);
});

test('trend sentences never end a half with a dangling "than"', () => {
  for (const d of [-3, -0.5, -0.49, 0, 0.49, 0.5, 3]) {
    const text = sentences(tr(d, d, d), tr(-d, -d, -d)).join(' ');
    assert.doesNotMatch(text, /than[,.]/);
    assert.doesNotMatch(text, /than and/);
  }
});
