// Page logic: dropdowns, loading, rendering as plain text. No stats here (see stats.js)
// and no fetching here (see api.js).

import { loadCityData } from './api.js';
import { analyse } from './stats.js';

const SELECTION_KEY = 'weather-anomaly:selection:v1';

const $ = (id) => document.getElementById(id);
const countrySel = $('country');
const citySel = $('city');
const statusEl = $('status');
const resultsEl = $('results');
const noteEl = $('note');

let locations = [];
let requestId = 0; // lets a newer selection cancel an older, slower request

// ---- remembered selection (localStorage, always in try/catch) ----

function saveSelection(country, city) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ country, city }));
  } catch { /* storage unavailable: just don't remember */ }
}

function loadSelection() {
  try {
    return JSON.parse(localStorage.getItem(SELECTION_KEY)) ?? {};
  } catch {
    return {};
  }
}

// ---- helpers ----

const fmt = (x) => x.toFixed(1);

function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

/** Replace an element's content with one <p> per line of text. */
function setParagraphs(el, lines) {
  el.replaceChildren(...lines.map((line) => {
    const p = document.createElement('p');
    p.textContent = line;
    return p;
  }));
}

function clearResults() {
  requestId++; // ignore any request still in flight
  statusEl.textContent = '';
  resultsEl.hidden = true;
  noteEl.hidden = true;
}

// ---- dropdowns ----

function fillCountries() {
  countrySel.replaceChildren(option('', 'Select a country'));
  for (const c of locations) countrySel.append(option(c.country, c.country));
}

function fillCities(countryName) {
  const country = locations.find((c) => c.country === countryName);
  if (!country) {
    citySel.replaceChildren(option('', 'Select a country first'));
    citySel.disabled = true;
    return;
  }
  // locations.json lists cities by population already (Islamabad last for Pakistan).
  citySel.replaceChildren(option('', 'Select a city'));
  for (const c of country.cities) citySel.append(option(c.name, c.name));
  citySel.disabled = false;
}

// ---- loading and rendering ----

async function showCity(countryName, cityName) {
  const country = locations.find((c) => c.country === countryName);
  const city = country?.cities.find((c) => c.name === cityName);
  if (!city) return;

  const myRequest = ++requestId;
  resultsEl.hidden = true;
  noteEl.hidden = true;
  statusEl.textContent = 'Loading…';

  try {
    const data = await loadCityData({ name: city.name, lat: city.lat, lon: city.lon });
    const result = analyse(data);
    if (myRequest !== requestId) return; // user picked something else meanwhile
    render(city.name, data.today, result);
    statusEl.textContent = '';
  } catch (err) {
    if (myRequest !== requestId) return;
    console.error(err);
    resultsEl.hidden = true;
    statusEl.textContent =
      "Sorry, we couldn't load the weather data right now. Please check your connection and try again.";
  }
}

function render(cityName, today, result) {
  $('results-title').textContent = today.isForecast
    ? `${cityName}, ${today.date}`
    : `${cityName}, ${today.date} (yesterday: today's values weren't available)`;

  const kind = today.isForecast ? 'forecast' : 'observed, yesterday';
  $('today').textContent = `High ${fmt(today.max)} °C, low ${fmt(today.min)} °C (${kind})`;

  setParagraphs($('summary'), result.summary);
  setParagraphs($('trend'), result.trendText);

  resultsEl.hidden = false;
  noteEl.hidden = false;
}

// ---- events ----

countrySel.addEventListener('change', () => {
  clearResults();
  fillCities(countrySel.value); // also resets the previously selected city
  saveSelection(countrySel.value, '');
});

citySel.addEventListener('change', () => {
  saveSelection(countrySel.value, citySel.value);
  if (countrySel.value && citySel.value) showCity(countrySel.value, citySel.value);
  else clearResults();
});

// ---- start ----

async function init() {
  try {
    const res = await fetch('data/locations.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    locations = await res.json();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Sorry, we couldn't load the list of countries. Please reload the page.";
    return;
  }

  fillCountries();
  fillCities('');

  const saved = loadSelection();
  if (saved.country && locations.some((c) => c.country === saved.country)) {
    countrySel.value = saved.country;
    fillCities(saved.country);
    if (saved.city && [...citySel.options].some((o) => o.value === saved.city)) {
      citySel.value = saved.city;
      showCity(saved.country, saved.city);
    }
  }
}

init();
