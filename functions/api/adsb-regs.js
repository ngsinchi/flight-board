const UA = "HKG-flight-board/1 (internal; https://adsb.fi)";
const IATA = ["CX", "LH", "LD", "LX", "3S", "NH", "C6", "MS", "6E", "CK", "MU"];
const ICAO_TO_IATA = {
  CPA: "CX", DLH: "LH", GEC: "LH", AHK: "LD", DHK: "LD",
  SWR: "LX", BOX: "3S", ANA: "NH", MFX: "C6", MSR: "MS",
  CKK: "CK", CES: "MU", IGO: "6E",
};
const HKG_LAT = 22.3080;
const HKG_LON = 113.9185;
const ADSB_URL = "https://opendata.adsb.fi/api/v3/lat/22.3080/lon/113.9185/dist/25";

function hkYmdNow() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = {};
  for (const x of fmt.formatToParts(new Date())) p[x.type] = x.value;
  return p.year + "-" + p.month + "-" + p.day;
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

function toRad(d) { return d * Math.PI / 180; }
function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function angDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
function inferDir(ac) {
  const alt = ac.alt_baro;
  const gs = ac.gs;
  const onGround = alt === "ground" || alt === 0 || gs === 0;
  const lat = ac.lat, lon = ac.lon;
  const track = ac.track != null ? ac.track : ac.true_heading;
  if (lat == null || lon == null || track == null || Number.isNaN(Number(track))) return "";
  const toHkg = bearing(lat, lon, HKG_LAT, HKG_LON);
  const toward = angDiff(Number(track), toHkg);
  const away = angDiff(Number(track), (toHkg + 180) % 360);
  const rate = ac.baro_rate != null ? ac.baro_rate : ac.geom_rate;
  if (onGround) return "";
  if (toward < 80 && (rate == null || rate <= 200)) return "arr";
  if (away < 80 && (rate == null || rate >= -200)) return "dep";
  return "";
}

export async function onRequest() {
  const today = hkYmdNow();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  let data = null;
  try {
    const res = await fetch(ADSB_URL, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("http " + res.status);
    data = await res.json();
  } catch (e) {
    clearTimeout(t);
    return new Response(JSON.stringify({ today, regs: [], error: "adsb unavailable" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, s-maxage=30, max-age=15",
      },
    });
  }
  clearTimeout(t);

  const list = (data && (data.ac || data.aircraft)) || [];
  const map = {};
  for (const ac of list) {
    const flight = normFlight(ac.flight);
    const reg = String(ac.r || "").trim().toUpperCase();
    if (!flight || !reg) continue;
    const dir = inferDir(ac);
    const rec = { flight, ymd: today, reg };
    if (dir) rec.dir = dir;
    const k = flight + "|" + (dir || "_") + "|" + reg;
    map[k] = rec;
  }

  return new Response(JSON.stringify({ today, source: "adsb.fi", regs: Object.values(map) }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, s-maxage=30, max-age=15",
    },
  });
}
