/* SK Hynix ADR Premium Tracker
 * Reads data/daily.json and data/intraday.json (built by scripts/fetch_and_build.py,
 * refreshed on a schedule by .github/workflows/update-data.yml) and renders:
 *   - a dual-axis price chart (000660.KS left axis, SKHY right axis), own range buttons
 *   - a dual-axis premium / ADR-volume-share chart, own range buttons
 *   - a stats strip (previous close, current price, previous-day volume, average
 *     volume, premium, volume share)
 * Range buttons: 1D, 5D, 1M, 3M, 6M, YTD, 1Y, 5Y, All.
 *
 * Charts use a category x-axis (plain date/timestamp label strings) rather than
 * Chart.js's time scale, so no date-adapter library is needed -- the whole app
 * runs off a single vendored Chart.js bundle (vendor/chart.umd.js), no CDN calls.
 */
(function () {
  const COLORS = {
    kospi: "#2a78d6",
    skhy: "#eb6834",
    premium: "#4a3aa7",
    volshare: "#1baf7a",
  };

  const RANGES = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "All"];
  // Premium/volume-share only exist from SKHY's debut onward (there's no ADR to
  // compare before that), so that chart's own "All" stays bounded to SKHY's life
  // even though the price chart's "All" now goes back to 000660.KS's own listing.
  const SKHY_LISTING_DATE = new Date("2026-07-08T00:00:00Z");

  let priceRange = "1M";
  let premiumRange = "1M";
  let daily = null;
  let intraday = null;
  let priceChart = null;
  let premiumChart = null;

  const $ = (id) => document.getElementById(id);

  function fmtNum(x, digits) {
    if (x === null || x === undefined || Number.isNaN(x)) return "–";
    return x.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  }

  function fmtVolume(x) {
    if (x === null || x === undefined || Number.isNaN(x)) return "–";
    if (x >= 1e9) return (x / 1e9).toFixed(2) + "B";
    if (x >= 1e6) return (x / 1e6).toFixed(2) + "M";
    if (x >= 1e3) return (x / 1e3).toFixed(1) + "K";
    return String(Math.round(x));
  }

  function lastNonNullPair(arr) {
    let last = -1, prev = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== null && arr[i] !== undefined) {
        if (last === -1) { last = i; }
        else { prev = i; break; }
      }
    }
    return [last, prev];
  }

  // Mean of the most recent `window` non-null values at or before uptoIndex.
  // Used for average volume, deliberately anchored at the last *completed*
  // session (uptoIndex should be the "previous day" index, not the possibly
  // still-forming latest one) so a partial in-progress session can't drag it down.
  function avgTrailing(arr, uptoIndex, window) {
    if (uptoIndex < 0) return null;
    const vals = [];
    for (let i = uptoIndex; i >= 0 && vals.length < window; i--) {
      if (arr[i] !== null && arr[i] !== undefined) vals.push(arr[i]);
    }
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  function buildRangeButtons(containerId, getRange, setRange) {
    const wrap = $(containerId);
    RANGES.forEach((r) => {
      const btn = document.createElement("button");
      btn.textContent = r;
      btn.dataset.range = r;
      if (r === getRange()) btn.classList.add("active");
      btn.addEventListener("click", () => {
        setRange(r);
        [...wrap.children].forEach((c) => c.classList.toggle("active", c.dataset.range === r));
      });
      wrap.appendChild(btn);
    });
  }

  // allBound: null means no lower bound (full history as fetched); a Date means
  // "All" is capped there instead (used for the premium chart, see SKHY_LISTING_DATE above).
  function cutoffDate(range, allBound) {
    const now = new Date();
    const d = new Date(now);
    switch (range) {
      case "1M": d.setMonth(d.getMonth() - 1); return d;
      case "3M": d.setMonth(d.getMonth() - 3); return d;
      case "6M": d.setMonth(d.getMonth() - 6); return d;
      case "YTD": return new Date(now.getFullYear(), 0, 1);
      case "1Y": d.setFullYear(d.getFullYear() - 1); return d;
      case "5Y": d.setFullYear(d.getFullYear() - 5); return d;
      case "All": return allBound || null;
      default: return null; // 1D / 5D use intraday.json instead
    }
  }

  // Slice daily.json's already date-aligned arrays down to a cutoff. Every
  // array in daily.json (kospi.*, skhy.*, premium_pct, adr_volume_share_pct)
  // is index-aligned to daily.dates, so no re-alignment is needed here.
  function dailySlice(cutoff) {
    let startIdx = 0;
    if (cutoff) {
      startIdx = daily.dates.findIndex((d) => new Date(d + "T00:00:00Z") >= cutoff);
      if (startIdx === -1) startIdx = daily.dates.length;
    }
    return {
      labels: daily.dates.slice(startIdx),
      kospiClose: daily.kospi.close.slice(startIdx),
      skhyClose: daily.skhy.close.slice(startIdx),
      premium: daily.premium_pct.slice(startIdx),
      volshare: daily.adr_volume_share_pct.slice(startIdx),
    };
  }

  // Union + sort timestamps across two intraday bar arrays, then align each
  // series to that shared label set (null where a series has no bar at that
  // timestamp -- expected, since Seoul and New York trading hours don't overlap).
  function alignIntraday(barsA, barsB) {
    const labelSet = new Set();
    barsA.forEach((b) => labelSet.add(b.t));
    barsB.forEach((b) => labelSet.add(b.t));
    const labels = [...labelSet].sort();
    const mapA = new Map(barsA.map((b) => [b.t, b.c]));
    const mapB = new Map(barsB.map((b) => [b.t, b.c]));
    return {
      labels,
      a: labels.map((t) => (mapA.has(t) ? mapA.get(t) : null)),
      b: labels.map((t) => (mapB.has(t) ? mapB.get(t) : null)),
    };
  }

  function filterToLastDay(bars) {
    if (!bars || !bars.length) return [];
    const lastDay = bars[bars.length - 1].t.slice(0, 10);
    return bars.filter((b) => b.t.slice(0, 10) === lastDay);
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Labels are already each exchange's own local wall-clock date/time (from the
  // fetch script's gmtoffset handling), so these format the raw string components
  // directly rather than going through Date parsing -- new Date(label) would
  // reinterpret an unqualified "YYYY-MM-DDTHH:MM:SS" string in the *viewer's*
  // browser timezone, silently shifting both the date (daily view) and the
  // time-of-day (intraday view) depending on where the viewer happens to be.
  function formatTick(label, intradayMode) {
    const m = intradayMode
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(label)
      : /^(\d{4})-(\d{2})-(\d{2})/.exec(label);
    if (!m) return label;
    const mon = MONTHS[parseInt(m[2], 10) - 1];
    const day = parseInt(m[3], 10);
    if (intradayMode) return `${mon} ${day}, ${m[4]}:${m[5]}`;
    return `${mon} ${day}`;
  }

  function chartOptions(intradayMode, axes) {
    const axisKeys = Object.keys(axes);
    const scales = {
      x: {
        grid: { display: false },
        ticks: {
          color: "#8a897f",
          autoSkip: true,
          maxTicksLimit: 10,
          maxRotation: 0,
          callback: function (value) {
            const label = this.getLabelForValue(value);
            return formatTick(label, intradayMode);
          },
        },
      },
    };
    axisKeys.forEach((key, i) => {
      const a = axes[key];
      scales[key] = {
        position: a.position,
        title: { display: true, text: a.title, color: a.color },
        ticks: { color: a.color },
        grid: { drawOnChartArea: i === 0 },
      };
    });
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? formatTick(items[0].label, intradayMode) : ""),
          },
        },
      },
      scales,
    };
  }

  function renderPriceChart() {
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    const intradayMode = priceRange === "1D" || priceRange === "5D";

    $("priceNote").textContent = intradayMode
      ? "Each line is shown in its own exchange's local trading hours (000660.KS: Korea time; SKHY: US Eastern time) on a shared axis, not a common clock. The two exchanges' trading hours do not overlap."
      : "";

    let labels, kospiPrice, skhyPrice;
    if (intradayMode) {
      const kospiBars = priceRange === "1D" ? filterToLastDay(intraday.kospi) : intraday.kospi;
      const skhyBars = priceRange === "1D" ? filterToLastDay(intraday.skhy) : intraday.skhy;
      const aligned = alignIntraday(kospiBars, skhyBars);
      labels = aligned.labels;
      kospiPrice = aligned.a;
      skhyPrice = aligned.b;
    } else {
      // "All" here means 000660.KS's own full history (as far back as the data
      // source has it), not just SKHY's ~1-month life -- unlike the premium
      // chart, the price chart is meaningful before the ADR existed.
      const s = dailySlice(cutoffDate(priceRange, null));
      labels = s.labels;
      kospiPrice = s.kospiClose;
      skhyPrice = s.skhyClose;
    }

    priceChart = new Chart($("priceChart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "000660.KS (KRW)",
            data: kospiPrice,
            borderColor: COLORS.kospi,
            backgroundColor: COLORS.kospi,
            yAxisID: "yKospi",
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.1,
            spanGaps: true,
          },
          {
            label: "SKHY (USD)",
            data: skhyPrice,
            borderColor: COLORS.skhy,
            backgroundColor: COLORS.skhy,
            yAxisID: "ySkhy",
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.1,
            spanGaps: true,
          },
        ],
      },
      options: chartOptions(intradayMode, {
        yKospi: { position: "left", title: "000660.KS (KRW)", color: COLORS.kospi },
        ySkhy: { position: "right", title: "SKHY (USD)", color: COLORS.skhy },
      }),
    });
  }

  function renderPremiumChart() {
    if (premiumChart) { premiumChart.destroy(); premiumChart = null; }
    const intradayMode = premiumRange === "1D" || premiumRange === "5D";

    let labels, premiumPts, volsharePts;
    if (intradayMode) {
      // Premium/volume-share need same-calendar-date pairing on both legs, which
      // intraday bars can't provide (non-overlapping trading hours) -- fall back
      // to the last ~6 daily sessions for this panel even in 1D/5D view.
      const s = dailySlice(new Date(Date.now() - 6 * 86400000));
      labels = s.labels;
      premiumPts = s.premium;
      volsharePts = s.volshare;
    } else {
      const s = dailySlice(cutoffDate(premiumRange, SKHY_LISTING_DATE));
      labels = s.labels;
      premiumPts = s.premium;
      volsharePts = s.volshare;
    }

    premiumChart = new Chart($("premiumChart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "ADR premium (%)",
            data: premiumPts,
            borderColor: COLORS.premium,
            backgroundColor: COLORS.premium,
            yAxisID: "yPremium",
            pointRadius: 2,
            borderWidth: 2,
            tension: 0.1,
            spanGaps: true,
          },
          {
            label: "ADR share of volume (%)",
            data: volsharePts,
            borderColor: COLORS.volshare,
            backgroundColor: COLORS.volshare,
            yAxisID: "yVolShare",
            pointRadius: 2,
            borderWidth: 2,
            tension: 0.1,
            spanGaps: true,
          },
        ],
      },
      options: chartOptions(false, {
        yPremium: { position: "left", title: "ADR premium (%)", color: COLORS.premium },
        yVolShare: { position: "right", title: "ADR share of volume (%)", color: COLORS.volshare },
      }),
    });
  }

  // Live weekday/time-of-day in a given IANA zone, via Intl rather than a
  // fixed UTC offset (so it stays correct across DST changes). Ignores
  // exchange holidays -- a market closed for a holiday will be (harmlessly)
  // treated as "open" if it falls within regular weekday trading hours.
  function nowInZone(timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    let hour = parseInt(get("hour"), 10);
    if (hour === 24) hour = 0; // some engines report midnight as "24" with hour12:false
    return {
      weekday: get("weekday"),
      dateStr: `${get("year")}-${get("month")}-${get("day")}`,
      minutesSinceMidnight: hour * 60 + parseInt(get("minute"), 10),
    };
  }

  function isWithinSession(zoneInfo, openH, openM, closeH, closeM) {
    if (zoneInfo.weekday === "Sat" || zoneInfo.weekday === "Sun") return false;
    const mins = zoneInfo.minutesSinceMidnight;
    return mins >= openH * 60 + openM && mins <= closeH * 60 + closeM;
  }

  // Regular-session hours only (no pre/post market). KRX: 09:00-15:30 KST.
  // Nasdaq: 09:30-16:00 ET.
  function isKospiOpen() {
    return isWithinSession(nowInZone("Asia/Seoul"), 9, 0, 15, 30);
  }
  function isSkhyOpen() {
    return isWithinSession(nowInZone("America/New_York"), 9, 30, 16, 0);
  }

  function updateStats() {
    const [kCur, kPrev] = lastNonNullPair(daily.kospi.close);
    const [sCur, sPrev] = lastNonNullPair(daily.skhy.close);
    const [pCur] = lastNonNullPair(daily.premium_pct);
    const [vCur] = lastNonNullPair(daily.adr_volume_share_pct);

    $("stat-kospi-prev").textContent = kPrev >= 0 ? "₩" + fmtNum(daily.kospi.close[kPrev], 0) : "–";
    $("stat-skhy-prev").textContent = sPrev >= 0 ? "$" + fmtNum(daily.skhy.close[sPrev], 2) : "–";
    $("stat-kospi-cur").textContent = kCur >= 0 ? "₩" + fmtNum(daily.kospi.close[kCur], 0) : "–";
    $("stat-skhy-cur").textContent = sCur >= 0 ? "$" + fmtNum(daily.skhy.close[sCur], 2) : "–";

    // Volume: the latest row is this market's current session while it's open
    // (running total, updated as the fetch script refreshes every 30 min) and
    // its most recently completed session once trading has closed for the day
    // -- so it's always the right number, just labeled according to whether
    // that market is trading right now.
    const kospiOpen = isKospiOpen();
    const skhyOpen = isSkhyOpen();

    $("stat-kospi-vol-label").textContent = "000660.KS Volume" + (kospiOpen ? " (Current Session)" : " (Previous Session)");
    $("stat-skhy-vol-label").textContent = "SKHY Volume" + (skhyOpen ? " (Current Session)" : " (Previous Session)");
    $("stat-kospi-vol").textContent = kCur >= 0 ? fmtVolume(daily.kospi.volume[kCur]) : "–";
    $("stat-skhy-vol").textContent = sCur >= 0 ? fmtVolume(daily.skhy.volume[sCur]) : "–";

    // Average volume should only count *completed* sessions -- if a market is
    // open right now, exclude the latest (still-accumulating) row from the
    // trailing window so a partial day doesn't drag the average down.
    $("stat-kospi-avgvol").textContent = fmtVolume(avgTrailing(daily.kospi.volume, kospiOpen ? kPrev : kCur, 30));
    $("stat-skhy-avgvol").textContent = fmtVolume(avgTrailing(daily.skhy.volume, skhyOpen ? sPrev : sCur, 30));

    $("stat-premium").textContent = pCur >= 0 ? fmtNum(daily.premium_pct[pCur], 2) + "%" : "–";
    $("stat-volshare").textContent = vCur >= 0 ? fmtNum(daily.adr_volume_share_pct[vCur], 2) + "%" : "–";

    const asOfDate = pCur >= 0 ? daily.dates[pCur] : (kCur >= 0 ? daily.dates[kCur] : "–");
    $("asof").textContent = `As of ${asOfDate} · data generated ${daily.generated_at}`;
  }

  async function loadData() {
    const [d, i] = await Promise.all([
      fetch("data/daily.json?_=" + Date.now()).then((r) => r.json()),
      fetch("data/intraday.json?_=" + Date.now()).then((r) => r.json()),
    ]);
    daily = d;
    intraday = i;
  }

  // The "Current Session" volume figures are only as fresh as the underlying
  // data (refreshed every 10 min by the scheduled fetch). Poll for updates
  // periodically so a page left open catches new data without a manual
  // reload, without hammering GitHub Pages -- 2 minutes is frequent enough to
  // notice a 10-minute refresh promptly.
  const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

  async function refresh() {
    try {
      await loadData();
      updateStats();
      renderPriceChart();
      renderPremiumChart();
    } catch (e) {
      console.error(e);
    }
  }

  async function init() {
    buildRangeButtons("priceRangeButtons", () => priceRange, (r) => { priceRange = r; renderPriceChart(); });
    buildRangeButtons("premiumRangeButtons", () => premiumRange, (r) => { premiumRange = r; renderPremiumChart(); });
    try {
      await loadData();
      updateStats();
      renderPriceChart();
      renderPremiumChart();
    } catch (e) {
      console.error(e);
      $("asof").textContent = "Failed to load data: " + e.message;
      return;
    }
    setInterval(refresh, REFRESH_INTERVAL_MS);
  }

  init();
})();
