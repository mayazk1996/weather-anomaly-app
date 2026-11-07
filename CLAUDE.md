# Weather Anomaly App

Guidance for Claude when working in this repository.

## What we're building

A free, personal (non-commercial) weather website. The user picks a **country**,
then a **city** in that country, and sees how today's temperature compares with
the same calendar date in every past year since 1940.

For the selected city, the page shows:

1. **Today's high and low** in °C.
2. **A statistical summary (2–3 lines)** covering today's **high and low**, for example:
   "Today's high of 16.4 °C in Berlin is in the 82nd percentile for 5 November
   since 1940 (12th warmest of 87, 2.1 °C above the long-term average of 14.3 °C).
   Tonight's low of 6.0 °C is in the 64th percentile, 0.8 °C above average."
3. **A plain-language trend description (2–3 sentences)** on how this date has
   changed over the years, for example:
   "5 November in Berlin has been fairly stable over the last 15 years, but highs
   are about 1.5 °C warmer than in the 1960s and 1970s."
4. **Two charts:**
   - the **daily high** on this date for every year since 1940, with today highlighted
   - the **daily low** on this date for every year since 1940, with today highlighted

The site is built once as a static site. There is no backend and no database.

## Countries and cities

There are exactly 5 countries, each with its top 5 cities by population. Pakistan
also has its capital, Islamabad, which makes 26 cities in total. The list is fixed
and approved by the user, so don't change it without asking.

| Country | Cities |
|---|---|
| Pakistan | Karachi, Lahore, Faisalabad, Rawalpindi, Gujranwala, Islamabad (capital) |
| Germany | Berlin, Hamburg, Munich, Cologne, Frankfurt am Main |
| Romania | Bucharest, Cluj-Napoca, Iași, Constanța, Timișoara |
| Bulgaria | Sofia, Plovdiv, Varna, Burgas, Ruse |
| Netherlands | Amsterdam, Rotterdam, The Hague, Utrecht, Eindhoven |

- Store the list in `data/locations.json`: country name, ISO code, city name,
  latitude, longitude and timezone. Write it by hand or look up the coordinates
  once with the Open-Meteo Geocoding API. Don't look anything up at runtime.

## Country and city selection

- There are two dropdowns: **Country** first, then **City**.
- The City dropdown is **disabled** until a country is chosen. Its placeholder reads
  "Select a country first".
- Choosing a country fills the City dropdown with that country's cities, sorted
  by population (Islamabad last for Pakistan), and resets any previously selected city.
- Changing the country clears the results and the city background.
- Nothing is fetched until both a country and a city are selected.
- Remember the last selection in localStorage (wrapped in try/catch) so the page
  reopens on it.

## Data

- **Weather source:** Open-Meteo (free for non-commercial use, no API key).
  - Today: `https://api.open-meteo.com/v1/forecast` with daily `temperature_2m_max`
    and `temperature_2m_min`, and `timezone=auto`. Today's values are a forecast;
    label them "forecast" on the page.
  - **Fallback:** if today's values aren't available, use **yesterday's** observed
    values. Say clearly on the page that the comparison is for yesterday.
  - History: `https://archive-api.open-meteo.com/v1/archive` with daily
    `temperature_2m_max` and `temperature_2m_min`, from 1940-01-01 through yesterday.
- **Attribution is required:** show "Weather data by Open-Meteo.com" with a link
  wherever data is displayed. The data is licensed CC BY 4.0.
- **Fair use:** stay well under 10,000 API calls a day. Cache each city's history
  in localStorage so it is fetched at most once a day per city.
- Add a short note on the page explaining that history comes from modelled
  reanalysis data on a grid, not from weather station readings.

## Statistics

- **Metrics:** the daily **maximum** and daily **minimum** temperature (°C),
  each calculated separately. The percentile, rank, difference from normal and
  label are worked out for the high and for the low.
- **Comparison set for the statistics and charts:** the value on the **same
  calendar date** (same month and day) in every year from 1940 through last year.
  That is about 86 values. Never use nearby days for the percentile, rank or charts.
- **Percentile:** the share of values in the comparison set that are below today's value.
- **Rank:** today's position among all the years, including today
  (for example, "12th warmest of 87").
- **Difference from normal:** today's high minus the mean high for this date over
  all years.
- **Labels:** below the 10th percentile is "unusually cold", 10th–25th is "cooler
  than usual", 25th–75th is "typical", 75th–90th is "warmer than usual", and
  above the 90th is "unusually warm".
- **Trend description (the only exception to the same-date rule):** to smooth out
  noise, use a window of **±7 days** around today's date in each year. For both
  highs and lows, compare the average over the last 15 years with (a) the 15 years
  before that and (b) the 1951–1980 reference period, and give the linear trend
  since 1940 in °C per decade. Name the comparison period once per sentence and
  keep each half complete, e.g. "highs were about 1.5 °C warmer than in 1996–2010,
  and lows about 0.7 °C warmer". If a change is less than 0.5 °C, say it is
  "similar to" that period (e.g. "highs were similar to 1996–2010, and lows
  similar"). Mention in the text that the trend is based on the week either side
  of the date.
- **29 February:** compare it with 28 February in non-leap years.
- **Missing years:** skip them, and state how many years were used.
- Put the statistics logic in `src/stats.js`, separate from the UI, with unit tests.

## Background images

- When a city is selected, the background shows a **photo of that city**.
  If there isn't one, show a photo of the country; if there isn't one of the country
  either, show the default background (Pakistani scenery, such as a markhor or
  green northern valleys).
- **Source:** Wikipedia and Wikimedia Commons only.
- **Allowed licenses only:** public domain, CC0, CC BY or CC BY-SA. Skip anything
  else, and skip images marked "fair use" or "non-free".
- Pick the images **once, at build time**, with `scripts/build_images.py` using the
  Wikimedia API. Use real photographs only: no maps, flags, coats of arms or logos.
- Save the result in `data/images.json`, recording for each image its URL, author,
  license, license URL and Commons source page.
- Show a small credit line on the page for the current background, with the author,
  the license and a link.
- Darken or blur the background behind the text so the dropdowns and results
  stay readable.

## Stack

- Plain HTML, CSS and JavaScript (ES modules). No framework and no build step.
- Charts: one lightweight library, loaded from a CDN (for example, Chart.js).
- Data scripts (locations and image mapping): Python.
- Hosting: GitHub Pages, served from the repository's `main` branch.

## Design

- Units: **°C only**, with no °F toggle. Round to one decimal place.
- Keep the layout clean and readable on mobile.
- The dropdowns and the result card sit over the background image.
- Show a loading state while data is fetched, and a friendly error message if a
  request fails.

## Working agreements

- Build in small steps and get each one working before starting the next.
- Never commit secrets. None should be needed, because Open-Meteo has no API key.
- Commercial use is out of scope. If that ever changes, the Open-Meteo license
  needs a paid plan.
- Keep this file updated when decisions change.

## Later (out of scope for now)

- Sending an email summary (for example, a daily email for a chosen city).
  Don't build this until the website works end to end.

## Commands

- Run locally: `python3 -m http.server 8000`, then open http://localhost:8000
- Run tests: `npm test` (Node's built-in test runner, no dependencies)
