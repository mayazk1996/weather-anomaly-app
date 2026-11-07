// Fetching weather data from Open-Meteo, with a per-city localStorage cache.
// No DOM here. fetch and storage can be injected so tests never touch the network.
// See CLAUDE.md → "Data".

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const HISTORY_START = '1940-01-01';
const CACHE_PREFIX = 'weather-anomaly:history:v1:';

const DAILY = 'temperature_2m_max,temperature_2m_min';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Previous calendar day of a "YYYY-MM-DD" string (done in UTC so DST can't shift it). */
export function previousDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** GET a URL and parse JSON; throws a readable Error on network or HTTP failure. */
async function getJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Open-Meteo returned HTTP ${res.status}`);
  return res.json();
}

/**
 * Today's high/low. Asks for yesterday too (past_days=1) so the fallback needs no second call.
 * Returns { date, max, min, isForecast }; if today's values are missing, yesterday's are used
 * and isForecast is false.
 */
export async function fetchToday({ lat, lon }, fetchImpl = globalThis.fetch) {
  const url = `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    `&daily=${DAILY}&timezone=auto&past_days=1&forecast_days=1`;
  const data = await getJson(url, fetchImpl);
  const { time, temperature_2m_max: max, temperature_2m_min: min } = data.daily ?? {};
  if (!Array.isArray(time) || time.length < 2) throw new Error('Unexpected forecast response');

  // With past_days=1 & forecast_days=1 the arrays are [yesterday, today].
  const t = time.length - 1;
  if (isNum(max[t]) && isNum(min[t])) {
    return { date: time[t], max: max[t], min: min[t], isForecast: true };
  }
  const y = t - 1;
  if (isNum(max[y]) && isNum(min[y])) {
    return { date: time[y], max: max[y], min: min[y], isForecast: false };
  }
  throw new Error('No temperature values available for today or yesterday');
}

/** Daily history from 1940-01-01 to endDate, as { time, temperature_2m_max, temperature_2m_min }. */
export async function fetchHistory({ lat, lon }, endDate, fetchImpl = globalThis.fetch) {
  const url = `${ARCHIVE_URL}?latitude=${lat}&longitude=${lon}` +
    `&start_date=${HISTORY_START}&end_date=${endDate}&daily=${DAILY}&timezone=auto`;
  const data = await getJson(url, fetchImpl);
  const d = data.daily;
  if (!d || !Array.isArray(d.time) || !d.time.length) throw new Error('Unexpected archive response');
  return {
    time: d.time,
    temperature_2m_max: d.temperature_2m_max,
    temperature_2m_min: d.temperature_2m_min,
  };
}

/** localStorage if usable, else null (private mode, blocked, or running under Node). */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const cacheKey = ({ lat, lon }) => `${CACHE_PREFIX}${lat},${lon}`;

/** Cached history if it was saved on `today` (the city's local date); otherwise null. */
export function readCache(city, today, storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(cacheKey(city));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry?.fetchedOn === today && entry.history?.time?.length) return entry.history;
  } catch { /* corrupt or unavailable cache: treat as a miss */ }
  return null;
}

/** Save history for `today`. Returns false if storage is full or unavailable. */
export function writeCache(city, today, history, storage = defaultStorage()) {
  try {
    storage.setItem(cacheKey(city), JSON.stringify({ fetchedOn: today, history }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything analyse() needs for one city: { city, history, today }.
 * city: { name, lat, lon }. History is fetched at most once per local day per city.
 * options: { fetch, storage } for tests.
 */
export async function loadCityData(city, { fetch: fetchImpl = globalThis.fetch, storage } = {}) {
  const store = storage === undefined ? defaultStorage() : storage;
  const today = await fetchToday(city, fetchImpl);

  // The real "today" is the forecast's date even when we fell back to yesterday's values.
  const realToday = today.isForecast ? today.date : null;
  const cacheDay = realToday ?? new Date(Date.parse(today.date) + 86400000).toISOString().slice(0, 10);

  let history = readCache(city, cacheDay, store);
  if (!history) {
    history = await fetchHistory(city, previousDay(cacheDay), fetchImpl);
    writeCache(city, cacheDay, history, store);
  }
  return { city: city.name, history, today };
}
