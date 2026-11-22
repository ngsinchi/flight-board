const AIRLINES = ["CX","LH","LD","LX","3S","NH","C6","MS","6E","CK","MU"];
const ICAO = {CX:"CPA",LH:"DLH",LD:"AHK",LX:"SWR","3S":"BOX",NH:"ANA",C6:"MFX",MS:"MSR",CK:"CKK",MU:"CES","6E":"IGO"};
const ICAO_TO_IATA = {CPA:"CX",DLH:"LH",GEC:"LH",AHK:"LD",DHK:"LD",SWR:"LX",BOX:"3S",ANA:"NH",MFX:"C6",MSR:"MS",CKK:"CK",CES:"MU",IGO:"6E"};
const FV = "https://fv.menziescnac.com/data2";
const HKIA = "https://www.hongkongairport.com/flightinfo-rest/rest/flights";

function pad2(n) { return String(n).padStart(2, "0"); }
function hasVal(v) { return v !== null && v !== undefined && String(v).trim() !== ""; }
function fillVal(a, b) { return hasVal(a) ? a : (hasVal(b) ? b : (a || b || "")); }
function normNo(no) { return String(no || "").replace(/\s+/g, "").toUpperCase(); }

function hhmm(v) {
  if (!hasVal(v)) return "";
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return m ? pad2(m[1]) + ":" + m[2] : "";
}

function hkNow() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const p = {};
  for (const x of fmt.formatToParts(new Date())) p[x.type] = x.value;
  return new Date(p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute + ":" + p.second + "+08:00");
}

export function hkYmd(offset) {
  const d = new Date(hkNow().getTime());
  d.setDate(d.getDate() + (offset || 0));
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" });
  const p = {};
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return p.year + "-" + p.month + "-" + p.day;
}

function shiftYmd(ymd, days) {
  if (!ymd) return "";
  const d = new Date(ymd + "T12:00:00+08:00");
  d.setTime(d.getTime() + (days || 0) * 86400000);
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" });
  const p = {};
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return p.year + "-" + p.month + "-" + p.day;
}

function parseHms(v) {
  const m = String(v || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return m ? { h: +m[1], m: +m[2], s: +(m[3] || 0) } : null;
}

function dayStamp(ymd, timeStr) {
  const hm = parseHms(timeStr);
  if (!hm || !ymd) return null;
  return new Date(ymd + "T" + pad2(hm.h) + ":" + pad2(hm.m) + ":" + pad2(hm.s) + "+08:00");
}

function airlineOf(flight) {
  const main = normNo(flight);
  const codes = AIRLINES.slice().sort((a, b) => b.length - a.length);
  for (const a of codes) {
    if (main.startsWith(a) && (main.length === a.length || (main.length > a.length && /\d/.test(main.charAt(a.length))))) return a;
  }
  return null;
}

function flightKey(no) {
  let s = normNo(no);
  if (!s) return "";
  for (const icao of Object.keys(ICAO_TO_IATA)) {
    if (s.startsWith(icao) && s.length > icao.length && /\d/.test(s.charAt(icao.length))) {
      s = ICAO_TO_IATA[icao] + s.slice(icao.length);
      break;
    }
  }
  const al = airlineOf(s);
  if (!al) return s;
  const m = s.slice(al.length).match(/^0*(\d+)(.*)$/);
  return m ? al + m[1] + (m[2] || "") : s;
}

function flightKeyBase(no) {
  return flightKey(no).replace(/D$/i, "");
}

function parseStatusYmd(s) {
  const m = String(s || "").match(/\((\d{1,2})\/(\d{1,2})\/(\d{4})\)/);
  if (!m) return "";
  return m[3] + "-" + pad2(+m[2]) + "-" + pad2(+m[1]);
}

function dateFilterFromYmd(ymd) {
  if (!ymd || ymd === hkYmd(0)) return "today";
  if (ymd === hkYmd(1)) return "tomorrow";
  return ymd;
}

function parseHkiaStatus(s) {
  s = String(s || "").trim();
  if (!s) return { label: "", time: "", ymd: "" };
  const ymd = parseStatusYmd(s);
  const m = s.match(/^(At gate|Dep|Est at|Landed|Cancelled)\s*(\d{1,2}:\d{2})?(?::\d{2})?(?:\s*\(\d{1,2}\/\d{1,2}\/\d{4}\))?$/i);
  if (!m) {
    const m2 = s.match(/(\d{1,2}:\d{2})(?::\d{2})?/);
    return { label: s, time: m2 ? m2[1] : "", ymd: ymd };
  }
  const map = { "at gate": "At gate", dep: "Dep", "est at": "Est at", landed: "Landed", cancelled: "Cancelled" };
  return { label: map[m[1].toLowerCase()] || m[1], time: m[2] || "", ymd: ymd };
}

function isActualStatus(s) {
  const x = (s || "").trim().toLowerCase();
  return x === "at gate" || x === "dep" || x.startsWith("at gate ") || x.startsWith("dep ");
}

function applyActualRules(r) {
  if (r.dir === "arr") {
    const st = (r.status || "").toLowerCase();
    if (st !== "at gate" && hasVal(r.atd)) {
      if (!hasVal(r.etd)) r.etd = r.atd;
      r.atd = "";
    }
  }
  return r;
}

function dutyYmd(r) {
  if (r && r.ymd) return r.ymd;
  if (r && r.date === "tomorrow") return hkYmd(1);
  if (r && /^\d{4}-\d{2}-\d{2}$/.test(r.date || "")) return r.date;
  return hkYmd(0);
}

function actualStamp(timeStr, r) {
  const opYmd = (r && (r.opYmd || r.ymd)) || dutyYmd(r);
  let at = dayStamp(opYmd, timeStr);
  if (!at) return null;
  const schedYmd = (r && r.schedYmd) || opYmd;
  const std = r ? dayStamp(schedYmd, r.std) : null;
  if (schedYmd === opYmd && std && at.getTime() < std.getTime() - 6 * 60 * 60 * 1000) {
    at = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  }
  return at;
}
function dropFutureActuals(r) {
  const rec = Object.assign({}, r);
  if (!hasVal(rec.atd)) return rec;
  const at = actualStamp(rec.atd, rec);
  if (at && at.getTime() > hkNow().getTime() + 5 * 60 * 1000) {
    rec.atd = "";
    if (isActualStatus(rec.status)) rec.status = hasVal(rec.etd) ? "Est at" : "";
  }
  return rec;
}

function stripStaleActuals(r) {
  const rec = dropFutureActuals(r);
  if (!hasVal(rec.atd) || !hasVal(rec.std)) return rec;
  const at = actualStamp(rec.atd, rec);
  const schedYmd = rec.schedYmd || rec.ymd || dutyYmd(rec);
  const stdAt = dayStamp(schedYmd, rec.std);
  if (!stdAt || !at) return rec;
  if (at.getTime() < stdAt.getTime() - 6 * 60 * 60 * 1000) {
    rec.atd = "";
    if (isActualStatus(rec.status)) rec.status = hasVal(rec.etd) ? "Est at" : "";
  }
  return rec;
}

function applyDayDelay(r) {
  if (!r) return r;
  const hadActual = hasVal(r.atd) || isActualStatus(r.status);
  const rec = stripStaleActuals(r);
  const sched = rec.schedYmd || (rec.dayDelay ? "" : rec.ymd) || dutyYmd(rec);
  let op = rec.opYmd || "";
  if (!op && sched) {
    const stdAt = dayStamp(sched, rec.std);
    const probe = hasVal(rec.atd) ? rec.atd : rec.etd;
    const opAt = dayStamp(sched, probe);
    if (stdAt && opAt && opAt.getTime() < stdAt.getTime() - 6 * 60 * 60 * 1000) {
      // Already-operated actuals on an early-morning clock belong to yesterday's
      // schedule (FV often keeps them under "today"). Only estimates shift op
      // to tomorrow. The 6h threshold itself is unchanged.
      if (hadActual) {
        rec.schedYmd = shiftYmd(sched, -1);
        rec.opYmd = sched;
        rec.ymd = sched;
        rec.date = dateFilterFromYmd(sched);
        const fl = normNo(rec.flight);
        if (fl && !/D$/i.test(fl)) rec.flight = fl + "D";
        rec.dayDelay = true;
        return rec;
      }
      op = shiftYmd(sched, 1);
    }
  }
  if (sched && op && op > sched) {
    const fl = normNo(rec.flight);
    if (fl && !/D$/i.test(fl)) rec.flight = fl + "D";
    rec.schedYmd = sched;
    rec.opYmd = op;
    rec.ymd = op;
    rec.date = dateFilterFromYmd(op);
    rec.dayDelay = true;
  } else if (rec.dayDelay || /D$/i.test(normNo(rec.flight))) {
    rec.flight = normNo(rec.flight).replace(/D$/i, "");
    if (sched) {
      rec.ymd = sched;
      rec.date = dateFilterFromYmd(sched);
    }
    rec.dayDelay = false;
    rec.opYmd = "";
  }
  return rec;
}

function timesFarBeforeStd(ymd, timeStr, std) {
  const stdAt = dayStamp(ymd, std);
  const at = dayStamp(ymd, timeStr);
  return !!(stdAt && at && at.getTime() < stdAt.getTime() - 6 * 60 * 60 * 1000);
}
function timeLaterThan(ymd, a, b) {
  if (timesFarBeforeStd(ymd, a, b)) return true;
  if (timesFarBeforeStd(ymd, b, a)) return false;
  const ta = dayStamp(ymd, a), tb = dayStamp(ymd, b);
  return !!(ta && tb && ta.getTime() > tb.getTime());
}
function distinctEtd(rec) {
  return hasVal(rec && rec.etd) && (!hasVal(rec.std) || hhmm(rec.etd) !== hhmm(rec.std));
}
function schedYmdOf(r) {
  return (r && (r.schedYmd || r.ymd || dutyYmd(r))) || "";
}
function adoptDelayedTime(rec, otherTime, ymd) {
  if (!rec || !hasVal(otherTime)) return rec;
  if (!hasVal(rec.std)) { rec.std = otherTime; return rec; }
  if (hhmm(rec.std) === hhmm(otherTime)) return rec;
  const day = ymd || schedYmdOf(rec);
  if (distinctEtd(rec)) {
    if (timeLaterThan(day, rec.std, otherTime)) rec.std = otherTime;
    return rec;
  }
  if (timeLaterThan(day, otherTime, rec.std)) rec.etd = otherTime;
  else { rec.etd = rec.std; rec.std = otherTime; }
  return rec;
}


function isMovedDayDelayOf(prev, rec) {
  const base = flightKeyBase(prev.flight);
  if (!base || /D$/i.test(flightKey(prev.flight))) return false;
  if (rec.dir !== prev.dir || flightKey(rec.flight) !== base + "D") return false;
  if (prev.std && rec.std && hhmm(prev.std) !== hhmm(rec.std)) return false;
  if (prev.schedYmd && rec.schedYmd && prev.schedYmd === rec.schedYmd) return true;
  const prevDay = prev.ymd || dutyYmd(prev);
  const recDay = rec.ymd || dutyYmd(rec);
  if (prevDay && recDay && prevDay === recDay) {
    if (hasVal(prev.atd) && hasVal(rec.atd) && hhmm(prev.atd) === hhmm(rec.atd)) return true;
    if (hasVal(prev.etd) && hasVal(rec.etd) && hhmm(prev.etd) === hhmm(rec.etd)) return true;
    const ymd = prev.schedYmd || prev.ymd || dutyYmd(prev);
    if (hasVal(prev.atd) && timesFarBeforeStd(ymd, prev.atd, prev.std)) return true;
  }
  return false;
}

function absorbDayDelayFields(dst, src) {
  dst.atd = fillVal(dst.atd, src.atd);
  dst.etd = fillVal(dst.etd, src.etd);
  dst.st = fillVal(dst.st, src.st);
  if (src.status && (!dst.status || (isActualStatus(src.status) && !isActualStatus(dst.status)))) dst.status = src.status;
  applyActualRules(dst);
}

function dropMovedDayDelaySources(rows) {
  const list = (rows || []).filter(Boolean).map(r => Object.assign({}, r));
  const delayed = list.filter(r => r.dayDelay || /D$/i.test(flightKey(r.flight)));
  delayed.forEach(d => {
    list.forEach(r => {
      if (!(r.dayDelay || /D$/i.test(flightKey(r.flight))) && isMovedDayDelayOf(r, d)) absorbDayDelayFields(d, r);
    });
  });
  return list.filter(r => {
    if (r.dayDelay || /D$/i.test(flightKey(r.flight))) return true;
    return !delayed.some(d => isMovedDayDelayOf(r, d));
  });
}

function foldDayDelays(rows) {
  const mapped = (rows || []).map(r => applyDayDelay(r));
  const map = new Map();
  mapped.forEach(h => {
    const k = h.date + "|" + h.dir + "|" + h.flight;
    if (!map.has(k)) { map.set(k, Object.assign({}, h)); return; }
    const d = map.get(k);
    d.atd = fillVal(d.atd, h.atd);
    d.std = fillVal(d.std, h.std);
    d.st = fillVal(d.st, h.st);
    d.schedYmd = (d.schedYmd && h.schedYmd) ? (d.schedYmd < h.schedYmd ? d.schedYmd : h.schedYmd) : fillVal(d.schedYmd, h.schedYmd);
    d.opYmd = (d.opYmd && h.opYmd) ? (d.opYmd > h.opYmd ? d.opYmd : h.opYmd) : fillVal(d.opYmd, h.opYmd);
    if (!d.atd && hasVal(h.etd)) d.etd = h.etd;
    else d.etd = fillVal(d.etd, h.etd);
    adoptDelayedTime(d, h.std, schedYmdOf(d) || schedYmdOf(h));
    if (h.status) {
      if (!d.status || (isActualStatus(h.status) && !isActualStatus(d.status))) d.status = h.status;
    }
    applyActualRules(d);
  });
  return dropMovedDayDelaySources(Array.from(map.values()).map(applyActualRules));
}

function isOfficialSrc(r) { return !!(r && /HKIA/i.test(r.src || "")); }
function dropContradictingFv(fv, hk) {
  const out = Object.assign({}, fv);
  if (!hk || !fv) return out;
  const cargo = isCargo(fv) || isCargo(hk);
  if (isActualStatus(hk.status)) return out;
  if (!(isActualStatus(fv.status) || hasVal(fv.atd))) return out;
  out.atd = "";
  if (isActualStatus(out.status)) out.status = hasVal(out.etd) ? "Est at" : "";
  if (!cargo) out.st = "";
  return out;
}
function mergeFlightFields(d, h) {
  const official = isOfficialSrc(d) && !isOfficialSrc(h) ? d : (isOfficialSrc(h) && !isOfficialSrc(d) ? h : null);
  const fvSide = official === d ? h : (official === h ? d : null);
  const left = official && fvSide && official === d ? official : (official && fvSide ? dropContradictingFv(d, official) : d);
  const right = official && fvSide && official === h ? official : (official && fvSide ? dropContradictingFv(h, official) : h);
  const src = (left.ymd && right.ymd && right.ymd > left.ymd) ? right : left;
  const other = src === left ? right : left;
  const out = Object.assign({}, src);
  out.src = (d.src && h.src && d.src !== h.src) ? "FV＋HKIA" : (src.src || other.src);
  const pick = field => official && hasVal(official[field]) ? official[field] : fillVal(src[field], other[field]);
  out.atd = pick("atd");
  out.std = pick("std");
  out.st = pick("st");
  if (official && hasVal(official.etd)) out.etd = official.etd;
  else if (!out.atd && hasVal(other.etd)) out.etd = other.etd;
  else out.etd = fillVal(src.etd, other.etd);
  adoptDelayedTime(out, other.std, schedYmdOf(out) || schedYmdOf(other));
  if (official && hasVal(official.status)) out.status = official.status;
  else if (other.status) {
    if (!out.status || (isActualStatus(other.status) && !isActualStatus(out.status))) out.status = other.status;
  }
  out.schedYmd = (src.schedYmd && other.schedYmd) ? (src.schedYmd < other.schedYmd ? src.schedYmd : other.schedYmd) : fillVal(src.schedYmd, other.schedYmd);
  out.opYmd = (src.opYmd && other.opYmd) ? (src.opYmd > other.opYmd ? src.opYmd : other.opYmd) : fillVal(src.opYmd, other.opYmd);
  if (other.dayDelay || src.dayDelay) out.dayDelay = true;
  return applyActualRules(out);
}


function officialDayDelayKey(r) {
  const rec = applyDayDelay(Object.assign({}, r));
  if (!(rec.dayDelay || /D$/i.test(flightKey(rec.flight)))) return "";
  return flightKeyBase(rec.flight) + "|" + rec.dir + "|" + (rec.schedYmd || "") + "|" + (rec.ymd || rec.opYmd || "");
}
function dropUnsupportedDayDelays(rows, hkiaRows) {
  if (!hkiaRows || !hkiaRows.length) return rows;
  const supported = new Set();
  const known = new Set();
  hkiaRows.forEach(h => {
    if (!h) return;
    known.add(flightKeyBase(h.flight) + "|" + h.dir);
    const k = officialDayDelayKey(h);
    if (k) supported.add(k);
  });
  return (rows || []).filter(r => {
    if (!(r && (r.dayDelay || /D$/i.test(flightKey(r.flight))))) return true;
    const base = flightKeyBase(r.flight) + "|" + r.dir;
    if (!known.has(base)) return true;
    const k = flightKeyBase(r.flight) + "|" + r.dir + "|" + (r.schedYmd || "") + "|" + (r.ymd || r.opYmd || "");
    return supported.has(k);
  });
}
function mergeRows(fvRows, hkiaRows) {
  const map = new Map();
  const key = r => r.date + "|" + r.dir + "|" + r.flight;
  const add = row => {
    const rec = applyDayDelay(Object.assign({}, row));
    const k = key(rec);
    if (!map.has(k)) { map.set(k, rec); return; }
    map.set(k, mergeFlightFields(map.get(k), rec));
  };
  (fvRows || []).forEach(add);
  (hkiaRows || []).forEach(add);
  return dropUnsupportedDayDelays(foldDayDelays(Array.from(map.values()).map(applyActualRules)), hkiaRows);
}

function isFreighterType(type) {
  const s = String(type || "").toUpperCase();
  return /\b(?:33Y|33X|74Y|74N|74F|77F|77Y|76F|75F|73F)\b/.test(s);
}
function isCargoAirline(al) {
  return al === "LD" || al === "CK" || al === "3S";
}
function isCargo(r) {
  const t = (r.t || "").toUpperCase();
  if (t === "F" || t === "H" || t === "A" || t === "M") return true;
  const al = (r.al || airlineOf(r.flight || "") || "").toUpperCase();
  if (isCargoAirline(al)) return true;
  if ((t === "T" || t === "K" || t === "P") && isFreighterType(r.type)) return true;
  return false;
}

function primaryStand(st) {
  let s = String(st || "").trim();
  if (!s) return "";
  s = s.replace(/\s*\([^)]*\)\s*/g, "").trim();
  return s;
}

function fvClockToDate(clock, now) {
  const m = String(clock || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  now = now || hkNow();
  const ymd = hkYmd(0);
  const stamp = new Date(ymd + "T" + pad2(+m[1]) + ":" + pad2(+m[2]) + ":" + pad2(+(m[3] || 0)) + "+08:00");
  if (stamp.getTime() > now.getTime() + 10 * 60 * 1000) return new Date(stamp.getTime() - 24 * 60 * 60 * 1000);
  return stamp;
}
function isFvFeedStale(clock, now) {
  const t = fvClockToDate(clock, now);
  if (!t) return false;
  return (now || hkNow()).getTime() - t.getTime() > 2 * 60 * 60 * 1000;
}
function dropStaleFvActuals(rec) {
  if (!rec) return rec;
  rec.fvStale = true;
  rec.atd = "";
  if (isActualStatus(rec.status)) rec.status = hasVal(rec.etd) ? "Est at" : "";
  rec.st = "";
  return rec;
}
function normalizeFv(r, dateFilter, arrDep, stale) {
  const flight = normNo(r.Flight || "");
  if (String(r.Flight || "").includes("[")) return null;
  const al = airlineOf(flight);
  if (!al) return null;
  const t = (r.T || "").toUpperCase();
  const cargo = isCargo({ al, t, type: r.Type || "", flight });
  if (al === "3S" && !cargo) return null;
  const arr = arrDep === "a";
  const ymd = dateFilter === "tomorrow" ? hkYmd(1) : (dateFilter === "today" ? hkYmd(0) : dateFilter);
  return {
    date: dateFilter, dir: arr ? "arr" : "dep", al, flight, t, ymd, schedYmd: ymd,
    type: r.Type || "", std: (arr ? r.STA : r.STD) || "", etd: (arr ? r.ETA : r.ETD) || "",
    atd: (arr ? r.ATA : r.ATD) || "", st: primaryStand(r.ST || ""), status: r.Status || "", src: "FV"
  };
}

function normalizeHkia(item, dateFilter, arrival, cargo, ymd) {
  const fl = item.flight || [];
  if (!fl.length) return null;
  const flight = normNo(fl[0].no);
  const al = airlineOf(flight);
  if (!al) return null;
  if (al === "3S" && !cargo) return null;
  const stt = parseHkiaStatus(item.status);
  const etd = (stt.label === "Est at" || stt.label === "Landed") ? stt.time : "";
  const atd = (stt.label === "At gate" || stt.label === "Dep") ? stt.time : "";
  return {
    date: dateFilter, dir: arrival ? "arr" : "dep", al, flight,
    t: cargo ? "F" : "J", ymd: ymd || (dateFilter === "tomorrow" ? hkYmd(1) : hkYmd(0)),
    schedYmd: ymd || (dateFilter === "tomorrow" ? hkYmd(1) : hkYmd(0)), opYmd: stt.ymd || "",
    std: item.time || "", etd, atd, st: primaryStand(item.stand || ""), status: stt.label, src: "HKIA"
  };
}

async function fetchJson(url, headers, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error("http " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonRetry(url, headers, ms, tries) {
  let last;
  for (let i = 0; i < (tries || 2); i++) {
    try { return await fetchJson(url, headers, ms); }
    catch (e) {
      last = e;
      await new Promise(res => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw last;
}

async function poolMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = e; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit || 5, items.length) }, worker));
  return out;
}

async function fetchFvOne(airline, arrDep, dateFilter) {
  const q = "&ha_filter=all&flight_id=" + encodeURIComponent(airline) + "&date_filter=" + dateFilter + "&arr_dep=" + arrDep;
  const headers = { Accept: "application/json", "User-Agent": "Mozilla/5.0" };
  const first = await fetchJsonRetry(FV + "?page=1" + q, headers, 8000);
  const stale = isFvFeedStale(first && first.last_update_time);
  let rows = first.rows || [];
  const total = first.total_pages || 1;
  if (total < 2) return { rows, stale };
  const pages = [];
  for (let p = 2; p <= total; p++) pages.push(p);
  const rest = await poolMap(pages, 6, p => fetchJsonRetry(FV + "?page=" + p + q, headers, 8000));
  rest.forEach(data => {
    if (data && data.rows) rows = rows.concat(data.rows);
  });
  return { rows, stale };
}

async function loadFv(dateFilters) {
  const jobs = [];
  for (const dateFilter of dateFilters) {
    for (const arrDep of ["a", "D"]) {
      for (const al of AIRLINES) {
        jobs.push({ al, arrDep, dateFilter });
      }
    }
  }
  const parts = await poolMap(jobs, 8, async job => {
    try {
      const packed = await fetchFvOne(job.al, job.arrDep, job.dateFilter);
      return (packed.rows || []).map(r => normalizeFv(r, job.dateFilter, job.arrDep, packed.stale)).filter(Boolean);
    } catch {
      return [];
    }
  });
  return parts.flatMap(x => Array.isArray(x) ? x : []);
}

async function loadHkia(days) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0",
    Referer: "https://www.hongkongairport.com/en/flights/arrivals/passenger.page"
  };
  const jobs = [];
  for (const d of days) for (const arrival of [true, false]) for (const cargo of [false, true]) {
    jobs.push({ d, arrival, cargo });
  }
  const settled = await poolMap(jobs, 8, async job => {
    const url = HKIA + "?date=" + job.d + "&arrival=" + job.arrival + "&cargo=" + job.cargo + "&lang=en";
    const blocks = await fetchJson(url, headers, 8000);
    const out = [];
    (blocks || []).forEach(block => {
      const df = dateFilterFromYmd(block.date);
      (block.list || []).forEach(item => {
        const rec = normalizeHkia(item, df, job.arrival, job.cargo, block.date);
        if (rec) out.push(rec);
      });
    });
    return out;
  });
  return settled.flatMap(x => Array.isArray(x) ? x : []);
}

function betterRow(a, b) {
  const score = r => (hasVal(r.atd) ? 4 : 0) + (hasVal(r.etd) ? 2 : 0) + (hasVal(r.st) ? 1 : 0);
  const aScore = score(a), bScore = score(b);
  if (bScore !== aScore) return bScore > aScore ? b : a;
  if (a.dayDelay !== b.dayDelay) return a.dayDelay ? a : b;
  return a;
}

function toCsvRows(rows, today) {
  const map = new Map();
  (rows || []).forEach(r => {
    const onToday = r.date === "today" || r.ymd === today || r.opYmd === today || r.schedYmd === today;
    if (!onToday) return;
    const fl = flightKey(r.flight);
    if (!fl) return;
    const dir = r.dir === "arr" ? "A" : "D";
    const rec = { key: fl + dir, flight: fl, dir, eta: hhmm(r.etd), ata: hhmm(r.atd), bay: r.st || "", dayDelay: !!r.dayDelay };
    const prev = map.get(rec.key);
    if (!prev) { map.set(rec.key, rec); return; }
    const win = betterRow({ atd: prev.ata, etd: prev.eta, st: prev.bay, dayDelay: prev.dayDelay }, r);
    map.set(rec.key, {
      key: rec.key,
      flight: rec.flight,
      dir,
      eta: hhmm(win.etd || win.eta),
      ata: hhmm(win.atd || win.ata),
      bay: primaryStand(win.st || win.bay || ""),
      dayDelay: !!win.dayDelay
    });
  });
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function csvEscape(s) {
  const t = String(s || "");
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function rowsToCsv(list) {
  const lines = ["key,flight,dir,eta,ata,bay"];
  for (const r of list) {
    lines.push([r.key, r.flight, r.dir, r.eta, r.ata, r.bay].map(csvEscape).join(","));
  }
  return "\uFEFF" + lines.join("\n") + "\n";
}

function parseCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const header = (lines.shift() || "").split(",");
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  return lines.filter(Boolean).map(line => {
    const cols = line.split(",");
    return {
      key: cols[idx.key] || "",
      flight: cols[idx.flight] || "",
      dir: cols[idx.dir] || "",
      eta: cols[idx.eta] || "",
      ata: cols[idx.ata] || "",
      bay: cols[idx.bay] || ""
    };
  }).filter(r => r.key);
}

function mergePrev(fresh, prev) {
  // Fresh-only keys: do not keep previous CSV rows that are absent from the
  // new FV+HKIA merge (prevents stale day-delay leftovers in the Excel feed).
  const oldMap = new Map();
  (prev || []).forEach(r => { if (r && r.key) oldMap.set(r.key, r); });
  return (fresh || []).map(r => {
    const old = oldMap.get(r.key);
    if (!old) return r;
    return {
      key: r.key,
      flight: r.flight || old.flight,
      dir: r.dir || old.dir,
      eta: hasVal(r.eta) ? r.eta : (old.eta || ""),
      ata: hasVal(r.ata) ? r.ata : (old.ata || ""),
      bay: hasVal(r.bay) ? r.bay : (old.bay || "")
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

export async function buildTimesCsv(prevCsv) {
  const today = hkYmd(0);
  const [fvRows, hkiaRows] = await Promise.all([
    loadFv(["today"]),
    loadHkia([today])
  ]);
  const merged = mergeRows(fvRows, hkiaRows);
  const fresh = toCsvRows(merged, today);
  return rowsToCsv(mergePrev(fresh, parseCsv(prevCsv)));
}

export { hkYmd as feedYmd, parseCsv, mergePrev, applyDayDelay, mergeRows, dropUnsupportedDayDelays };

