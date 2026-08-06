# SK Hynix ADR Premium Tracker

A small static web app tracking SK Hynix's Nasdaq ADR (**SKHY**) against its Korea
Exchange common shares (**000660.KS**): price on a dual y-axis chart, the ADR premium,
and the ADR's share of aggregate (common-share-equivalent) trading volume.

Methodology matches Gagnon and Karolyi's SK Hynix ADR case study:

```
premium_pct           = (SKHY close (USD) x 10 x USD/KRW close) / 000660.KS close (KRW) - 1
adr_volume_share_pct  = (SKHY volume / 10) / (SKHY volume / 10 + 000660.KS volume)
```

(x10 / /10 because 1 SKHY ADR = 1/10 of one 000660.KS common share.)

## Live site

Once GitHub Pages is enabled (see below), the app is served at:

```
https://louisgagnon.github.io/sk-hynix-adr-tracker/
```

## How it works

- `scripts/fetch_and_build.py` pulls daily OHLCV history and 5-day/15-minute intraday
  bars for SKHY, 000660.KS, and USD/KRW from Yahoo Finance's public chart API, computes
  the premium and volume-share series, and writes `data/daily.json` and
  `data/intraday.json`.
- `.github/workflows/update-data.yml` runs that script on a schedule (every 30 minutes)
  and commits any changed data back to the repo.
- `index.html` / `app.js` / `style.css` are a plain static frontend (Chart.js via CDN,
  no build step) that reads the two JSON files and renders the charts, range buttons
  (1D/5D/1M/3M/6M/YTD/All), and the stats strip.

## Enabling GitHub Pages

1. Repo Settings -> Pages -> Build and deployment -> Source: **Deploy from a branch**.
2. Branch: **main**, folder **/ (root)**.
3. Save. The site is live in a minute or two at the URL above.

**Note:** GitHub Pages is only available on private repositories with a paid GitHub
plan (Pro/Team/Enterprise), and even then the published site is only visible to people
with repo access, not the general public. Since this app contains no sensitive
information, the simplest way to get a URL you can share with anyone (including people
without a GitHub account) is to make this repository public first.

## Running / testing locally

```
python3 scripts/fetch_and_build.py   # refresh data/daily.json and data/intraday.json
python3 -m http.server 8000          # serve the static files
# open http://localhost:8000
```

## Data conventions

Dates are each exchange's own local trading-day label (New York for SKHY, Seoul for
000660.KS), derived from Yahoo's per-series `gmtoffset` rather than a naive UTC
conversion, which would mislabel some bars (particularly FX) a day early.
