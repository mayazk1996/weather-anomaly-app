import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchToday, fetchHistory, loadCityData, previousDay, readCache } from '../src/api.js';
import { analyse } from '../src/stats.js';

const berlin = { name: 'Berlin', lat: 52.52, lon: 13.41 };

// A fake fetch that routes by URL and records every call.
function fakeFetch({ forecast, archive, status = 200 }) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const body = url.includes('archive-api') ? archive : forecast;
    return { ok: status === 200, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// A fake localStorage backed by a Map.
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    size: () => m.size,
  };
}

const forecastOk = {
  daily: {
    time: ['2026-11-06', '2026-11-07'],
    temperature_2m_max: [10, 12.5],
    temperature_2m_min: [3, 4.5],
  },
};
const forecastTodayMissing = {
  daily: {
    time: ['2026-11-06', '2026-11-07'],
    temperature_2m_max: [10, null],
    temperature_2m_min: [3, null],
  },
};

// Daily history 2020-01-01..2025-12-31 would be big; a small synthetic one is enough.
function makeArchive(years) {
  const time = [], hi = [], lo = [];
  for (const y of years) {
    time.push(`${y}-11-07`);
    hi.push(10 + (y % 5));
    lo.push(2 + (y % 3));
  }
  return { daily: { time, temperature_2m_max: hi, temperature_2m_min: lo } };
}

test('previousDay handles month, year and leap boundaries', () => {
  assert.equal(previousDay('2026-11-07'), '2026-11-06');
  assert.equal(previousDay('2026-01-01'), '2025-12-31');
  assert.equal(previousDay('2024-03-01'), '2024-02-29');
});

test('fetchToday returns today as a forecast', async () => {
  const f = fakeFetch({ forecast: forecastOk });
  const t = await fetchToday(berlin, f);
  assert.deepEqual(t, { date: '2026-11-07', max: 12.5, min: 4.5, isForecast: true });
  assert.match(f.calls[0], /forecast/);
  assert.match(f.calls[0], /timezone=auto/);
  assert.match(f.calls[0], /past_days=1/);
});

test("fetchToday falls back to yesterday's values when today's are null", async () => {
  const t = await fetchToday(berlin, fakeFetch({ forecast: forecastTodayMissing }));
  assert.deepEqual(t, { date: '2026-11-06', max: 10, min: 3, isForecast: false });
});

test('fetchToday throws when neither day has values', async () => {
  const empty = { daily: { time: ['a', 'b'], temperature_2m_max: [null, null], temperature_2m_min: [null, null] } };
  await assert.rejects(fetchToday(berlin, fakeFetch({ forecast: empty })), /No temperature values/);
});

test('fetchToday throws a readable error on HTTP failure', async () => {
  await assert.rejects(fetchToday(berlin, fakeFetch({ forecast: {}, status: 500 })), /HTTP 500/);
});

test('fetchToday throws a readable error when the network fails', async () => {
  const down = async () => { throw new Error('offline'); };
  await assert.rejects(fetchToday(berlin, down), /Network error: offline/);
});

test('fetchHistory requests 1940 through the given end date', async () => {
  const f = fakeFetch({ archive: makeArchive([1940, 1941]) });
  const h = await fetchHistory(berlin, '2026-11-06', f);
  assert.deepEqual(h.time, ['1940-11-07', '1941-11-07']);
  assert.match(f.calls[0], /start_date=1940-01-01/);
  assert.match(f.calls[0], /end_date=2026-11-06/);
});

test('fetchHistory rejects an empty archive response', async () => {
  await assert.rejects(fetchHistory(berlin, '2026-11-06', fakeFetch({ archive: { daily: { time: [] } } })), /Unexpected archive/);
});

test('loadCityData returns the shape analyse() expects', async () => {
  const years = Array.from({ length: 60 }, (_, i) => 1960 + i);
  const f = fakeFetch({ forecast: forecastOk, archive: makeArchive(years) });
  const data = await loadCityData(berlin, { fetch: f, storage: fakeStorage() });
  assert.equal(data.city, 'Berlin');
  const out = analyse(data); // must not throw
  assert.equal(out.high.years, 60);
  assert.equal(out.summary.length, 3);
});

test('history is cached: second call the same day skips the archive', async () => {
  const storage = fakeStorage();
  const f = fakeFetch({ forecast: forecastOk, archive: makeArchive([1990, 1991]) });
  await loadCityData(berlin, { fetch: f, storage });
  await loadCityData(berlin, { fetch: f, storage });
  const archiveCalls = f.calls.filter((u) => u.includes('archive-api'));
  assert.equal(archiveCalls.length, 1);
  assert.equal(f.calls.filter((u) => u.includes('/v1/forecast')).length, 2); // today is always fresh
});

test('cache is refreshed on a new day and kept per city', async () => {
  const storage = fakeStorage();
  const archive = makeArchive([1990]);
  const day1 = fakeFetch({ forecast: forecastOk, archive });
  await loadCityData(berlin, { fetch: day1, storage });

  const nextDay = {
    daily: { time: ['2026-11-07', '2026-11-08'], temperature_2m_max: [1, 2], temperature_2m_min: [0, 1] },
  };
  const day2 = fakeFetch({ forecast: nextDay, archive });
  await loadCityData(berlin, { fetch: day2, storage });
  assert.equal(day2.calls.filter((u) => u.includes('archive-api')).length, 1);

  const munich = { name: 'Munich', lat: 48.14, lon: 11.58 };
  await loadCityData(munich, { fetch: day2, storage });
  assert.equal(storage.size(), 2);
});

test("when today's values are missing, the cache day is still the real today", async () => {
  const storage = fakeStorage();
  const f = fakeFetch({ forecast: forecastTodayMissing, archive: makeArchive([1990]) });
  const data = await loadCityData(berlin, { fetch: f, storage });
  assert.equal(data.today.isForecast, false);
  assert.match(f.calls.find((u) => u.includes('archive-api')), /end_date=2026-11-06/);
  assert.ok(readCache(berlin, '2026-11-07', storage));
});

test('works when storage is unavailable or throws', async () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
  const f = fakeFetch({ forecast: forecastOk, archive: makeArchive([1990]) });
  const withBroken = await loadCityData(berlin, { fetch: f, storage: broken });
  const withNull = await loadCityData(berlin, { fetch: f, storage: null });
  assert.equal(withBroken.history.time.length, 1);
  assert.equal(withNull.history.time.length, 1);
});

test('a corrupt cache entry is ignored', () => {
  const storage = { getItem: () => '{not json', setItem() {} };
  assert.equal(readCache(berlin, '2026-11-07', storage), null);
});
