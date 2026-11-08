#!/usr/bin/env python3
"""Download daily max/min temperature since 1940 for every city in data/locations.json.

Writes one compact file per city: data/history/<country>-<city>.json

    {"country": "Germany", "city": "Berlin", "start": "1940-01-01", "end": "2026-11-06",
     "generated": "2026-11-07", "max": [1.2, 0.8, ...], "min": [-3.4, null, ...]}

`max` and `min` hold one value per day from `start`, rounded to 1 decimal
(null = missing day). No dates are stored per day.

Cities are fetched one at a time with a pause between requests (Open-Meteo's free
tier is rate limited). If a city already has a file, only the missing recent days are
downloaded and appended (the last few days are fetched again, because Open-Meteo can
revise them). A city that is already up to date is skipped, so an interrupted run can
simply be started again. Use --force to re-download everything from 1940.

On HTTP 429 the script waits 1, then 5, then 15 minutes. If it is still rate limited it
stops with a short message; cities finished so far are saved.

Weather data by Open-Meteo.com (CC BY 4.0), https://open-meteo.com/
Standard library only.
"""

import argparse
import json
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCATIONS = ROOT / "data" / "locations.json"
OUT_DIR = ROOT / "data" / "history"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
START = date(1940, 1, 1)
RATE_LIMIT_WAITS = (60, 300, 900)  # seconds to wait before retry 1, 2, 3
OVERLAP_DAYS = 14  # re-fetch this many days already saved, in case they were revised


class RateLimited(Exception):
    """Open-Meteo kept answering HTTP 429 after all retries."""


def slug(text):
    """'Iași' -> 'iasi', 'Frankfurt am Main' -> 'frankfurt-am-main'.
    Must match historyPath() in src/api.js."""
    folded = unicodedata.normalize("NFD", text)
    ascii_only = "".join(c for c in folded if not unicodedata.combining(c))
    out = []
    for c in ascii_only.lower():
        out.append(c if c.isalnum() else "-")
    return "-".join(p for p in "".join(out).split("-") if p)


def history_file(country, city):
    return OUT_DIR / f"{slug(country)}-{slug(city)}.json"


def fetch_range(city, timezone, first, last):
    """One archive request for one city and date range. Waits and retries on HTTP 429."""
    query = urllib.parse.urlencode({
        "latitude": city["lat"],
        "longitude": city["lon"],
        "start_date": first.isoformat(),
        "end_date": last.isoformat(),
        "daily": "temperature_2m_max,temperature_2m_min",
        "timezone": timezone,
    })
    url = f"{ARCHIVE_URL}?{query}"
    for attempt in range(len(RATE_LIMIT_WAITS) + 1):
        try:
            with urllib.request.urlopen(url, timeout=120) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            if err.code != 429:
                raise
            if attempt == len(RATE_LIMIT_WAITS):
                raise RateLimited() from None
            wait = RATE_LIMIT_WAITS[attempt]
            print(f"    rate limited (429); waiting {wait // 60} min, then retrying", flush=True)
            time.sleep(wait)
    raise RuntimeError("unreachable")


def round1(values):
    return [None if v is None else round(v, 1) for v in values]


def parse_range(data, first, last):
    """Check an API response covers exactly first..last; return (max, min) rounded."""
    daily = data["daily"]
    expected = (last - first).days + 1
    times = daily["time"]
    if not times or times[0] != first.isoformat() or len(times) != expected:
        got = f"{len(times)} from {times[0]}" if times else "none"
        raise ValueError(f"expected {expected} days from {first}, got {got}")
    hi, lo = round1(daily["temperature_2m_max"]), round1(daily["temperature_2m_min"])
    if len(hi) != expected or len(lo) != expected:
        raise ValueError("max/min arrays do not match the number of days")
    return hi, lo


def read_existing(target):
    """The saved file as a dict, or None if missing or not usable (then we download all)."""
    if not target.exists():
        return None
    try:
        d = json.loads(target.read_text(encoding="utf-8"))
        end = date.fromisoformat(d["end"])
        ok = (d["start"] == START.isoformat() and len(d["max"]) == len(d["min"])
              == (end - START).days + 1)
        return d if ok else None
    except (ValueError, KeyError, TypeError):
        return None


def build_file(country, city, existing, timezone, yesterday):
    """Return (payload, note), or (None, note) if the saved file is already up to date."""
    if existing is None:
        first, keep_hi, keep_lo, note = START, [], [], "downloading everything"
    else:
        saved_end = date.fromisoformat(existing["end"])
        if saved_end >= yesterday:
            return None, "already up to date"
        # Drop the last few saved days and fetch them again along with the new ones.
        first = max(START, saved_end - timedelta(days=OVERLAP_DAYS - 1))
        keep = (first - START).days
        keep_hi, keep_lo = existing["max"][:keep], existing["min"][:keep]
        note = f"adding {(yesterday - saved_end).days} new day(s)"
    hi, lo = parse_range(fetch_range(city, timezone, first, yesterday), first, yesterday)
    return {
        "country": country,
        "city": city["name"],
        "start": START.isoformat(),
        "end": yesterday.isoformat(),
        "generated": date.today().isoformat(),
        "max": keep_hi + hi,
        "min": keep_lo + lo,
    }, note


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pause", type=float, default=15.0, help="seconds to wait between cities (default 15)")
    ap.add_argument("--force", action="store_true", help="re-download cities that already have a file")
    ap.add_argument("--only", help="only this city name (for testing), e.g. --only Berlin")
    args = ap.parse_args()

    locations = json.loads(LOCATIONS.read_text(encoding="utf-8"))
    jobs = [(c["country"], c["timezone"], city) for c in locations for city in c["cities"]]
    if args.only:
        jobs = [j for j in jobs if j[2]["name"].lower() == args.only.lower()]
        if not jobs:
            sys.exit(f"No city named {args.only!r} in {LOCATIONS}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    yesterday = date.today() - timedelta(days=1)
    failed = []
    need_pause = False

    for i, (country, tz, city) in enumerate(jobs, 1):
        target = history_file(country, city["name"])
        label = f"[{i}/{len(jobs)}] {city['name']}, {country}"
        existing = None if args.force else read_existing(target)
        if target.exists() and existing is None and not args.force:
            print(f"{label}: saved file is damaged, downloading everything again")
        if existing is not None and date.fromisoformat(existing["end"]) >= yesterday:
            print(f"{label}: already up to date, skipping")
            continue

        if need_pause:
            time.sleep(args.pause)
        need_pause = True
        try:
            payload, note = build_file(country, city, existing, tz, yesterday)
            print(f"{label}: {note}…", flush=True)
            tmp = target.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
            tmp.replace(target)  # never leave a half-written file behind
            print(f"    saved {target.relative_to(ROOT)} ({target.stat().st_size // 1024} KB)")
        except RateLimited:
            sys.exit("Rate limit reached. Run again later; finished cities are saved.")
        except Exception as err:  # keep going; report at the end
            print(f"{label}: FAILED: {err}")
            failed.append(city["name"])

    if failed:
        sys.exit(f"Failed: {', '.join(failed)}. Run the script again to retry just these.")
    print("Done.")


if __name__ == "__main__":
    main()
