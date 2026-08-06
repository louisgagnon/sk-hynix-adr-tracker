#!/usr/bin/env python3
"""Fetch SKHY / 000660.KS / USDKRW data from Yahoo Finance and build the JSON
files the tracker web app reads (data/daily.json, data/intraday.json).

Formulas match the Gagnon-Karolyi SK Hynix ADR case study:

    premium_pct            = (skhy_close_usd * 10 * usdkrw_close / kospi_close_krw - 1) * 100
    adr_volume_share_pct   = (skhy_volume / 10) / (skhy_volume / 10 + kospi_volume) * 100

(x10 / /10 because 1 SKHY ADR = 1/10 of one 000660.KS common share.)

Dates are each series' own exchange-local trading-day label (derived from
Yahoo's per-series `gmtoffset`), not a naive UTC conversion -- a naive UTC
conversion mislabels FX bars (London-midnight-anchored) one day early.

Usage:
    python3 fetch_and_build.py
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; sk-hynix-adr-tracker/1.0)"}
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(ROOT, "data")

SKHY_LISTING_DATE = "2026-07-08"  # small pad before the 2026-07-10 debut


def _get_json(url, timeout=25, retries=3):
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            last_err = e
    raise last_err


def fetch_chart(symbol, *, range_=None, interval="1d", period1=None, period2=None):
    params = [f"interval={interval}"]
    if range_:
        params.append(f"range={range_}")
    else:
        params.append(f"period1={period1}")
        params.append(f"period2={period2}")
    url = f"{CHART_URL.format(symbol=symbol)}?{'&'.join(params)}"
    payload = _get_json(url)
    result = payload["chart"]["result"]
    if not result:
        raise ValueError(f"no data for {symbol}: {payload['chart'].get('error')}")
    return result[0]


def daily_series(symbol, start_date, end_date=None):
    """Fetch daily OHLCV, return dict keyed by exchange-local trading date."""
    period1 = int(datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    if end_date:
        period2 = int(datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()) + 86400
    else:
        period2 = int(datetime.now(tz=timezone.utc).timestamp()) + 86400
    r = fetch_chart(symbol, interval="1d", period1=period1, period2=period2)
    ts = r["timestamp"]
    gmtoffset = r["meta"].get("gmtoffset", 0)
    quote = r["indicators"]["quote"][0]
    out = {}
    for i, t in enumerate(ts):
        if quote["close"][i] is None:
            continue
        d = datetime.fromtimestamp(t + gmtoffset, tz=timezone.utc).date().isoformat()
        out[d] = {
            "open": quote["open"][i],
            "high": quote["high"][i],
            "low": quote["low"][i],
            "close": quote["close"][i],
            "volume": quote["volume"][i],
        }
    return out


def intraday_series(symbol, range_="5d", interval="15m"):
    """Fetch intraday bars, return list of {t: iso8601-with-offset, c: close}."""
    r = fetch_chart(symbol, range_=range_, interval=interval)
    ts = r["timestamp"]
    gmtoffset = r["meta"].get("gmtoffset", 0)
    quote = r["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(ts):
        if quote["close"][i] is None:
            continue
        local = datetime.fromtimestamp(t + gmtoffset, tz=timezone.utc)
        out.append({"t": local.strftime("%Y-%m-%dT%H:%M:%S"), "c": quote["close"][i]})
    return out


def build_daily(kospi, skhy, usdkrw):
    dates = sorted(set(kospi) | set(skhy))
    out = {
        "dates": dates,
        "kospi": {k: [kospi.get(d, {}).get(k) for d in dates] for k in ("open", "high", "low", "close", "volume")},
        "skhy": {k: [skhy.get(d, {}).get(k) for d in dates] for k in ("open", "high", "low", "close", "volume")},
        "usdkrw_close": [usdkrw.get(d, {}).get("close") for d in dates],
        "premium_pct": [],
        "adr_volume_share_pct": [],
    }
    for d in dates:
        k, s, fx = kospi.get(d), skhy.get(d), usdkrw.get(d)
        if k and s and fx:
            adr_implied_krw = s["close"] * 10 * fx["close"]
            premium = (adr_implied_krw / k["close"] - 1) * 100
            out["premium_pct"].append(round(premium, 4))
            skhy_eq = s["volume"] / 10
            share = skhy_eq / (skhy_eq + k["volume"]) * 100 if (skhy_eq + k["volume"]) else None
            out["adr_volume_share_pct"].append(round(share, 4) if share is not None else None)
        else:
            out["premium_pct"].append(None)
            out["adr_volume_share_pct"].append(None)
    return out


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    ok = True

    print("Fetching daily history...")
    try:
        kospi_daily = daily_series("000660.KS", "2015-01-01")
        skhy_daily = daily_series("SKHY", SKHY_LISTING_DATE)
        usdkrw_daily = daily_series("KRW=X", "2015-01-01")
        daily = build_daily(kospi_daily, skhy_daily, usdkrw_daily)
        daily["generated_at"] = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(os.path.join(DATA_DIR, "daily.json"), "w") as f:
            json.dump(daily, f, separators=(",", ":"))
        print(f"  wrote daily.json ({len(daily['dates'])} dates)")
    except Exception as e:
        print(f"[FAIL] daily fetch: {e}", file=sys.stderr)
        ok = False

    print("Fetching intraday (5d/15m) history...")
    try:
        intraday = {
            "generated_at": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "kospi": intraday_series("000660.KS"),
            "skhy": intraday_series("SKHY"),
        }
        with open(os.path.join(DATA_DIR, "intraday.json"), "w") as f:
            json.dump(intraday, f, separators=(",", ":"))
        print(f"  wrote intraday.json (kospi={len(intraday['kospi'])} bars, skhy={len(intraday['skhy'])} bars)")
    except Exception as e:
        print(f"[FAIL] intraday fetch: {e}", file=sys.stderr)
        ok = False

    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
