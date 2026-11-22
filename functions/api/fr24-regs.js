const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FR24 = {
  Accept: "application/json",
  "User-Agent": UA,
  Origin: "https://www.flightradar24.com",
  Referer: "https://www.flightradar24.com/",
};
const IATA = ["CX", "LH", "LD", "LX", "3S", "NH", "C6", "MS", "6E", "CK", "MU"];
const ICAO_TO_IATA = {
  CPA: "CX", DLH: "LH", GEC: "LH", AHK: "LD", DHK: "LD",
  SWR: "LX", BOX: "3S", ANA: "NH", MFX: "C6", MSR: "MS",
  CKK: "CK", CES: "MU", IGO: "6E",
};

function hkYmd(ts) {
  if (!ts) return "";
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = {};
  for (const x of fmt.formatToParts(new Date(ts * 1000))) p[x.type] = x.value;
  return p.year + "-" + p.month + "-" + p.day;
}
function hkHm(ts) {
  if (!ts) return "";
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = {};
  for (const x of fmt.formatToParts(new Date(ts * 1000))) p[x.type] = x.value;
  return (p.hour && p.minute) ? (p.hour + ":" + p.minute) : "";
}

function todayTomorrow() {
  const now = Date.now() / 1000;
  return { today: hkYmd(now), tomorrow: hkYmd(now + 24 * 3600) };
}

async function fetchJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  try {
    const res = await fetch(url, { headers: FR24, signal: ctrl.signal });
    if (!res.ok) throw new Error("http " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function stripLeadZeros(al, rest) {
  const m = String(rest || "").match(/^0*(\d+)(.*)$/);
  return m ? al + m[1] + (m[2] || "") : al + rest;
}
function normFlight(no) {
  const s = String(no || "").replace(/\s+/g, "").toUpperCase();
  if (!s) return "";
  for (const icao of Object.keys(ICAO_TO_IATA)) {
    if (s.startsWith(icao) && s.length > icao.length && /\d/.test(s.charAt(icao.length))) {
      return stripLeadZeros(ICAO_TO_IATA[icao], s.slice(icao.length));
    }
  }
  const codes = IATA.slice().sort((a, b) => b.length - a.length);
  for (const a of codes) {
    if (s.startsWith(a) && s.length > a.length && /\d/.test(s.charAt(a.length))) {
      return stripLeadZeros(a, s.slice(a.length));
    }
  }
  return "";
}

function pushReg(out, rec) {
  if (!rec || !rec.flight || !rec.dir || !rec.ymd) return;
  if (!rec.reg && !rec.atd) return;
  const k = rec.ymd + "|" + rec.dir + "|" + rec.flight;
  const cur = out[k] || { flight: rec.flight, dir: rec.dir, ymd: rec.ymd };
  if (rec.reg) cur.reg = rec.reg;
  if (rec.atd) cur.atd = rec.atd;
  out[k] = cur;
}

function parseFeed(data, today) {
  const out = [];
  for (const [id, v] of Object.entries(data || {})) {
    if (id === "full_count" || id === "version" || !Array.isArray(v) || v.length < 14) continue;
    const flight = normFlight(v[13]);
    const reg = String(v[9] || "").trim().toUpperCase();
    if (!flight || !reg) continue;
    const origin = String(v[11] || "").toUpperCase();
    const dest = String(v[12] || "").toUpperCase();
    let dir = "";
    if (dest === "HKG") dir = "arr";
    else if (origin === "HKG") dir = "dep";
    else continue;
    out.push({ flight, dir, ymd: today, reg });
  }
  return out;
}

function parseFlightList(data, flight, today, tomorrow) {
  const rows = ((((data || {}).result || {}).response || {}).data) || [];
  const out = [];
  for (const item of rows) {
    const reg = String(((item.aircraft || {}).registration) || "").trim().toUpperCase();
    const ap = item.airport || {};
    const orig = (((ap.origin || {}).code) || {}).iata || "";
    const dest = (((ap.destination || {}).code) || {}).iata || "";
    const times = item.time || {};
    const sched = times.scheduled || {};
    const real = times.real || {};
    let dir = "";
    let ts = 0;
    let atd = "";
    if (dest === "HKG") {
      dir = "arr";
      ts = sched.arrival || real.arrival;
      atd = hkHm(real.arrival);
    } else if (orig === "HKG") {
      dir = "dep";
      ts = sched.departure || real.departure;
      atd = hkHm(real.departure);
    } else continue;
    const ymd = hkYmd(ts > 1e12 ? ts / 1000 : ts);
    if (ymd !== today && ymd !== tomorrow) continue;
    if (!reg && !atd) continue;
    out.push({ flight, dir, ymd, reg, atd });
  }
  return out;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const wanted = [...new Set((url.searchParams.get("q") || "").split(",").map((s) => normFlight(s)).filter(Boolean))].slice(0, 30);
  const { today, tomorrow } = todayTomorrow();
  const map = {};

  try {
    const feed = await fetchJson(
      "https://data-cloud.flightradar24.com/zones/fcgi/feed.js?faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=1&air=1&vehicles=0&estimated=1&maxage=14400&gliders=0&stats=0&bounds=22.6,22.1,113.7,114.3"
    );
    for (const rec of parseFeed(feed, today)) pushReg(map, rec);
  } catch (e) {}

  const missing = wanted.filter((fl) => !Object.keys(map).some((k) => k.endsWith("|" + fl)));
  for (let i = 0; i < missing.length; i += 4) {
    const group = missing.slice(i, i + 4);
    await Promise.all(group.map(async (fl) => {
      try {
        const data = await fetchJson(
          "https://api.flightradar24.com/common/v1/flight/list.json?query=" +
            encodeURIComponent(fl) +
            "&fetchBy=flight&limit=20"
        );
        for (const rec of parseFlightList(data, fl, today, tomorrow)) pushReg(map, rec);
      } catch (e) {}
    }));
  }

  return new Response(JSON.stringify({ today, tomorrow, regs: Object.values(map) }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, s-maxage=60, max-age=30",
    },
  });
}
