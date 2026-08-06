/* SK Hynix ADR Premium Tracker
 * Reads data/daily.json and data/intraday.json (built by scripts/fetch_and_build.py,
 * refreshed on a schedule by .github/workflows/update-data.yml) and renders:
 *   - a dual-axis price chart (000660.KS left axis, SKHY right axis)
 *   - a dual-axis premium / ADR-volume-share chart
 *   - a stats strip (previous close, current price, volume, premium, volume share)
 * Range buttons: 1D, 5D, 1M, 3M, 6M, YTD, All.
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

  const RANGES = ["1D", "5D", "1M", "3M", "6M", "YTD", "All"];
  const SKHY_LISTING_DATE = new Date("2026-07-08T00:00:00Z");
  let currentRange = "1M";
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
    if (x === null || x === undefined) return "–";
    if (x >= 1e9) return (x / 1e9).toFixed(2) + "B";
    if (x >= 1e6) return (x / 1e6).toFixed(2) + "M";
    if (x >= 1e3) return (x / 1e3).toFixed(1) + "K";
    return String(x);
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

  function buildRangeButtons() {
    const wrap = $("rangeButtons");
    RANGES.forEach((r) => {
      const btn = document.createElement("button");
      btn.textContent = r;
      btn.dataset.range = r;
      if (r === currentRange) btn.classList.add("active");
      btn.addEventListener("click", () => {
        currentRange = r;
        [...wrap.children].forEach((c) => c.classList.toggle("active", c.dataset.range === r));
        renderCharts();
      });
      wrap.appendChild(btn);
    });
  }

  function cutoffDate() {
    const now = new Date();
    const d = new Date(now);
    switch (currentRange) {
      case "1M": d.setMonth(d.getMonth() - 1); return d;
      case "3M": d.setMonth(d.getMonth() - 3); return d;
      case "6M": d.setMonth(d.getMonth() - 6); return d;
      case "YTD": return new Date(now.getFullYear(), 0, 1);
      // "All" means the ADR's whole life, not 000660.KS's full multi-year history --
      // sharing an x-axis with a decade of pre-listing KOSPI-only data would squeeze
      // SKHY's ~1-month existence into an unreadable sliver at the right edge.
      case "All": return SKHY_LISTING_DATE;
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

  function destroyCharts() {
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    if (premiumChart) { premiumChart.destroy(); premiumChart = null; }
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

  function renderCharts() {
    destroyCharts();
    const intradayMode = currentRange === "1D" || currentRange === "5D";

    $("priceNote").textContent = intradayMode
      ? "Each line is shown in its own exchange's local trading hours (000660.KS: Korea time; SKHY: US Eastern time) on a shared axis, not a common clock. The two exchanges' trading hours do not overlap."
      : "";

    let priceLabels, kospiPrice, skhyPrice, premiumLabels, premiumPts, volsharePts;

    if (intradayMode) {
      const kospiBars = currentRange === "1D" ? filterToLastDay(intraday.kospi) : intraday.kospi;
      const skhyBars = currentRange === "1D" ? filterToLastDay(intraday.skhy) : intraday.skhy;
      const aligned = alignIntraday(kospiBars, skhyBars);
      priceLabels = aligned.labels;
      kospiPrice = aligned.a;
      skhyPrice = aligned.b;

      // Premium/volume-share need same-calendar-date pairing on both legs, which
      // intraday bars can't provide (non-overlapping trading hours) -- keep using
      // the last ~6 daily sessions for this panel even in 1D/5D price view.
      const cutoff = new Date(Date.now() - 6 * 86400000);
      const s = dailySlice(cutoff);
      premiumLabels = s.labels;
      premiumPts = s.premium;
      volsharePts = s.volshare;
    } else {
      const s = dailySlice(cutoffDate());
      priceLabels = s.labels;
      kospiPrice = s.kospiClose;
      skhyPrice = s.skhyClose;
      premiumLabels = s.labels;
      premiumPts = s.premium;
      volsharePts = s.volshare;
    }

    priceChart = new Chart($("priceChart"), {
      type: "line",
      data: {
        labels: priceLabels,
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

    premiumChart = new Chart($("premiumChart"), {
      type: "line",
      data: {
        labels: premiumLabels,
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

  function updateStats() {
    const [kCur, kPrev] = lastNonNullPair(daily.kospi.close);
    const [sCur, sPrev] = lastNonNullPair(daily.skhy.close);
    const [pCur] = lastNonNullPair(daily.premium_pct);
    const [vCur] = lastNonNullPair(daily.adr_volume_share_pct);

    $("stat-kospi-prev").textContent = kPrev >= 0 ? "₩" + fmtNum(daily.kospi.close[kPrev], 0) : "–";
    $("stat-skhy-prev").textContent = sPrev >= 0 ? "$" + fmtNum(daily.skhy.close[sPrev], 2) : "–";
    $("stat-kospi-cur").textContent = kCur >= 0 ? "₩" + fmtNum(daily.kospi.close[kCur], 0) : "–";
    $("stat-skhy-cur").textContent = sCur >= 0 ? "$" + fmtNum(daily.skhy.close[sCur], 2) : "–";
    $("stat-kospi-vol").textContent = kCur >= 0 ? fmtVolume(daily.kospi.volume[kCur]) : "–";
    $("stat-skhy-vol").textContent = sCur >= 0 ? fmtVolume(daily.skhy.volume[sCur]) : "–";
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

  async function init() {
    buildRangeButtons();
    try {
      await loadData();
      updateStats();
      renderCharts();
    } catch (e) {
      console.error(e);
      $("asof").textContent = "Failed to load data: " + e.message;
    }
  }

  init();
})();
