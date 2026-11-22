import { getSession, json, normalizeStaffId } from "../_lib/auth.js";

function timingSafeEqualStr(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a || ""));
  const bb = enc.encode(String(b || ""));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function writeKeyOk(request, env) {
  const expected = env.MYORDER_WRITE_KEY || "";
  if (!expected) return false;
  const header = request.headers.get("X-MyOrder-Key") || "";
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return timingSafeEqualStr(header, expected) || timingSafeEqualStr(bearer, expected);
}

function normYmd(raw) {
  const s = String(raw || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function normTime(raw) {
  const s = String(raw || "").trim();
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]), min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
  }
  m = s.match(/^(\d{3,4})$/);
  if (m) {
    const t = m[1].padStart(4, "0");
    const h = Number(t.slice(0, 2)), min = Number(t.slice(2));
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
  }
  return "";
}

function normFlight(raw) {
  return String(raw || "").replace(/\s+/g, "").toUpperCase();
}

function flightKey(raw) {
  const f = normFlight(raw);
  const m = f.match(/^([A-Z]{2,3}|[A-Z0-9]{2,3})(\d{1,4})([A-Z]?)$/);
  if (!m) return f;
  return m[1] + (m[2].replace(/^0+/, "") || "0") + (m[3] || "");
}

export async function removeFlightsFromStaff(db, staffId, flights) {
  const list = (flights || []).filter((f) => f && flightKey(f.flight));
  if (!list.length) return;
  await ensureSchema(db);
  const byYmd = new Map();
  const noYmd = [];
  for (const f of list) {
    const ymd = normYmd(f.ymd || f.date);
    if (ymd) {
      if (!byYmd.has(ymd)) byYmd.set(ymd, []);
      byYmd.get(ymd).push(f);
    } else {
      noYmd.push(f);
    }
  }
  if (noYmd.length) {
    const rows = await loadOrders(db, staffId, null);
    for (const row of rows) {
      if (!byYmd.has(row.ymd)) byYmd.set(row.ymd, []);
      byYmd.get(row.ymd).push(...noYmd);
    }
  }
  const now = new Date().toISOString();
  const stmts = [];
  for (const [ymd, fls] of byYmd) {
    const taken = new Set();
    const takenDir = new Set();
    for (const f of fls) {
      const k = flightKey(f.flight);
      if (!k) continue;
      taken.add(k);
      const d = normDir(f.dir);
      if (d) takenDir.add(d + "|" + k);
    }
    if (!taken.size) continue;
    const row = await db.prepare(
      "SELECT flights FROM my_orders WHERE staff_id = ? AND ymd = ?"
    ).bind(staffId, ymd).first();
    if (!row) continue;
    let prev = [];
    try { prev = JSON.parse(row.flights || "[]"); } catch { prev = []; }
    if (!Array.isArray(prev) || !prev.length) continue;
    const next = prev.filter((f) => {
      if (!f) return false;
      const k = flightKey(f.flight);
      const d = normDir(f.dir);
      if (d && takenDir.size) return !takenDir.has(d + "|" + k);
      return !taken.has(k);
    });
    if (next.length === prev.length) continue;
    stmts.push(db.prepare(
      "UPDATE my_orders SET flights = ?, updated_at = ? WHERE staff_id = ? AND ymd = ?"
    ).bind(JSON.stringify(next), now, staffId, ymd));
  }
  if (stmts.length) await db.batch(stmts);
}

function cleanStaffIds(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const id = normalizeStaffId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function assignmentKey(f) {
  const k = flightKey(f && f.flight);
  if (!k) return "";
  return k + "|" + normInfo(f && f.info);
}

/**
 * Session PUTs without replace/drop may add (superset) or update the same set.
 * A subset or mixed/disjoint list is treated as a stale tab and must not
 * drop flights that are still on the server.
 */
export function resolveSessionFlights(prev, incoming) {
  const prevList = Array.isArray(prev) ? prev : [];
  const nextList = Array.isArray(incoming) ? incoming : [];
  if (!prevList.length) return nextList;
  const prevKeys = new Set(prevList.map((f) => flightKey(f && f.flight)).filter(Boolean));
  const nextKeys = new Set(nextList.map((f) => flightKey(f && f.flight)).filter(Boolean));
  const allPrevInNext = [...prevKeys].every((k) => nextKeys.has(k));
  if (allPrevInNext) return nextList;
  return prevList;
}

export function sortFlightsByTime(flights) {
  return (flights || []).slice().sort((a, b) => {
    const ta = normTime(a && a.time);
    const tb = normTime(b && b.time);
    const sa = /^\d{2}:\d{2}$/.test(ta) ? 0 : 1;
    const sb = /^\d{2}:\d{2}$/.test(tb) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const aKey = sa ? "99:99" : ta;
    const bKey = sb ? "99:99" : tb;
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    const fa = flightKey(a && a.flight);
    const fb = flightKey(b && b.flight);
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
}

/** Writer merge: keep existing flights and add/overwrite by flight number. */
export function mergeFlights(existing, incoming) {
  const out = [];
  const index = new Map();
  for (const rec of existing || []) {
    if (!rec || typeof rec !== "object") continue;
    const item = { ...rec };
    const fn = flightKey(item.flight);
    if (fn) index.set(fn, out.length);
    out.push(item);
  }
  for (const rec of incoming || []) {
    if (!rec || typeof rec !== "object") continue;
    const item = { ...rec };
    const fn = flightKey(item.flight);
    if (fn && index.has(fn)) {
      const prev = out[index.get(fn)];
      if (!String(item.time || "").trim()) {
        if (prev.time) item.time = prev.time;
        if (!String(item.dir || "").trim() && prev.dir) item.dir = prev.dir;
      }
      out[index.get(fn)] = item;
    } else {
      if (fn) index.set(fn, out.length);
      out.push(item);
    }
  }
  return sortFlightsByTime(out);
}

export function dropFlightsFromList(prev, drop) {
  const keys = new Set((drop || []).map((f) => flightKey(f && f.flight)).filter(Boolean));
  if (!keys.size) return Array.isArray(prev) ? prev.slice() : [];
  return (prev || []).filter((f) => f && !keys.has(flightKey(f.flight)));
}

/** Drop only the same flight with the same cargo/info; keep other types on the same flight. */
export function unassignOverlappingFlights(prev, incoming) {
  const taken = new Set((incoming || []).map((f) => assignmentKey(f)).filter(Boolean));
  if (!taken.size) return Array.isArray(prev) ? prev.slice() : [];
  return (prev || []).filter((f) => f && !taken.has(assignmentKey(f)));
}

async function unassignFlightsFromOthers(db, staffId, ymd, flights, keepStaff) {
  const taken = new Set((flights || []).map((f) => assignmentKey(f)).filter(Boolean));
  if (!taken.size) return;
  const keep = new Set((keepStaff || []).map((id) => normalizeStaffId(id)).filter(Boolean));
  keep.add(staffId);
  const rows = (await db.prepare(
    "SELECT staff_id, flights FROM my_orders WHERE ymd = ? AND staff_id != ?"
  ).bind(ymd, staffId).all()).results || [];
  const now = new Date().toISOString();
  const stmts = [];
  for (const row of rows) {
    if (keep.has(row.staff_id)) continue;
    let prev = [];
    try { prev = JSON.parse(row.flights || "[]"); } catch { prev = []; }
    if (!Array.isArray(prev) || !prev.length) continue;
    const next = unassignOverlappingFlights(prev, flights);
    if (next.length === prev.length) continue;
    stmts.push(db.prepare(
      "UPDATE my_orders SET flights = ?, updated_at = ? WHERE staff_id = ? AND ymd = ?"
    ).bind(JSON.stringify(next), now, row.staff_id, ymd));
  }
  if (stmts.length) await db.batch(stmts);
}

function normDir(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (s === "A" || s === "ARR" || s === "ARRIVAL") return "A";
  if (s === "D" || s === "DEP" || s === "DEPARTURE") return "D";
  return "";
}

function formatInfoToken(tok) {
  if (/^loading$/i.test(tok)) return "Loading";
  return tok.toUpperCase();
}

function normInfo(raw) {
  const parts = Array.isArray(raw) ? raw : [raw];
  const lines = [];
  for (const part of parts) {
    String(part || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").forEach((line) => {
      const t = line.replace(/[^\S\n]+/g, " ").trim();
      if (!t) return;
      lines.push(t.split(/(\s+)/).map((tok) => tok.trim() ? formatInfoToken(tok) : tok).join(""));
    });
  }
  let s = lines.join("\n");
  if (!s) return "";
  if (s.length > 200) s = s.slice(0, 200).replace(/\n[^\n]*$/, "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 *./@\n-]*$/.test(s)) return "";
  return s;
}

function normMiscAt(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

function parseMiscItem(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    let text = String(item.text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (text.length > 120) text = text.slice(0, 120).trim();
    return { text, at: normMiscAt(item.at || item.received_at || "") };
  }
  let text = String(item || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (text.length > 120) text = text.slice(0, 120).trim();
  return { text, at: "" };
}

function cleanMisc(input, defaultAt) {
  if (!Array.isArray(input)) return null;
  const stamp = normMiscAt(defaultAt);
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const rec = parseMiscItem(item);
    if (!rec.text) continue;
    const key = rec.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const row = { text: rec.text };
    const at = rec.at || stamp;
    if (at) row.at = at;
    out.push(row);
  }
  return out.slice(0, 20);
}

const MISC_EXPIRE_MS = 120 * 60 * 1000;

function pruneExpiredMisc(items, nowMs) {
  return (items || []).filter((it) => {
    if (!it || !it.at) return true;
    const t = Date.parse(it.at);
    if (!Number.isFinite(t)) return true;
    return nowMs - t < MISC_EXPIRE_MS;
  });
}

function cleanFlights(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (!item) continue;
    const flight = normFlight(typeof item === "string" ? item : item.flight);
    if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(flight)) continue;
    const time = normTime(typeof item === "string" ? "" : item.time);
    const dir = normDir(typeof item === "string" ? "" : item.dir);
    const info = typeof item === "string" ? "" : normInfo(item.info);
    const key = flight + "|" + time + "|" + dir;
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = { flight };
    if (time) rec.time = time;
    if (dir) rec.dir = dir;
    if (info) rec.info = info;
    out.push(rec);
  }
  return out;
}

async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS my_orders (
      staff_id TEXT NOT NULL,
      ymd TEXT NOT NULL,
      flights TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (staff_id, ymd)
    )`
  ).run();
  try {
    await db.prepare("ALTER TABLE my_orders ADD COLUMN misc TEXT").run();
  } catch (e) {}
}

async function loadOrders(db, staffId, ymd) {
  await ensureSchema(db);
  if (ymd) {
    const row = await db.prepare(
      "SELECT staff_id, ymd, flights, misc, updated_at FROM my_orders WHERE staff_id = ? AND ymd = ?"
    ).bind(staffId, ymd).first();
    return row ? [row] : [];
  }
  return (await db.prepare(
    "SELECT staff_id, ymd, flights, misc, updated_at FROM my_orders WHERE staff_id = ? ORDER BY ymd DESC"
  ).bind(staffId).all()).results || [];
}

function parseMisc(raw) {
  let misc = [];
  try { misc = JSON.parse(raw || "[]"); } catch { misc = []; }
  if (!Array.isArray(misc)) return [];
  const out = [];
  const seen = new Set();
  for (const item of misc) {
    const rec = parseMiscItem(item);
    if (!rec.text) continue;
    const key = rec.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const row = { text: rec.text };
    if (rec.at) row.at = rec.at;
    out.push(row);
  }
  return out;
}

function formatRows(rows) {
  return (rows || []).map((row) => {
    let flights = [];
    try { flights = JSON.parse(row.flights || "[]"); } catch { flights = []; }
    if (!Array.isArray(flights)) flights = [];
    return { ymd: row.ymd, flights, misc: parseMisc(row.misc), updated_at: row.updated_at };
  });
}

function keepExistingInfo(prevFlights, nextFlights) {
  const prev = Array.isArray(prevFlights) ? prevFlights : [];
  return (nextFlights || []).map((f) => {
    if (!f || f.info) return f;
    const fl = f.flight;
    const tm = f.time || "";
    const hit = prev.find((p) => p && p.flight === fl && p.info && (!tm || p.time === tm))
      || prev.find((p) => p && p.flight === fl && p.info);
    if (!hit) return f;
    const rec = { ...f, info: hit.info };
    if (!rec.time && hit.time) rec.time = hit.time;
    return rec;
  });
}

function mergeMisc(prev, incoming) {
  const out = [];
  const seen = new Set();
  for (const item of [...(incoming || []), ...(prev || [])]) {
    const rec = parseMiscItem(item);
    if (!rec.text) continue;
    const key = rec.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const row = { text: rec.text };
    if (rec.at) row.at = rec.at;
    out.push(row);
  }
  return out.slice(0, 20);
}

async function upsertOrder(db, staffId, ymd, { flights, misc, keepInfo, mergeMiscWithPrev, protectExisting, mergeWriter, dropFlights }) {
  await ensureSchema(db);
  const row = await db.prepare(
    "SELECT flights, misc FROM my_orders WHERE staff_id = ? AND ymd = ?"
  ).bind(staffId, ymd).first();
  let prevFlights = [];
  try { prevFlights = JSON.parse((row && row.flights) || "[]"); } catch { prevFlights = []; }
  if (!Array.isArray(prevFlights)) prevFlights = [];
  const prevMisc = parseMisc(row && row.misc);

  let nextFlights = prevFlights;
  if (flights) {
    let incoming = flights;
    if (protectExisting) incoming = resolveSessionFlights(prevFlights, flights);
    else if (mergeWriter) incoming = mergeFlights(prevFlights, flights);
    nextFlights = keepInfo ? keepExistingInfo(prevFlights, incoming) : incoming;
  }
  if (dropFlights && dropFlights.length) {
    nextFlights = dropFlightsFromList(nextFlights, dropFlights);
  }
  const nextMisc = misc ? (mergeMiscWithPrev ? mergeMisc(prevMisc, misc) : misc) : prevMisc;
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO my_orders (staff_id, ymd, flights, misc, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(staff_id, ymd) DO UPDATE SET flights = excluded.flights, misc = excluded.misc, updated_at = excluded.updated_at`
  ).bind(staffId, ymd, JSON.stringify(nextFlights), JSON.stringify(nextMisc), now).run();
  return { at: now, flights: nextFlights, misc: nextMisc };
}

export async function onRequestGet(context) {
  const sess = await getSession(context.env, context.request);
  const asWriter = writeKeyOk(context.request, context.env);
  if (!sess && !asWriter) return json({ error: "未登入" }, 401);
  const url = new URL(context.request.url);
  let staffId;
  if (asWriter) {
    staffId = normalizeStaffId(url.searchParams.get("staff_id"));
    if (!staffId) return json({ error: "職員編號不正確" }, 400);
  } else {
    staffId = sess.staff_id;
  }
  const ymd = normYmd(url.searchParams.get("ymd"));
  const rows = await loadOrders(context.env.DB, staffId, ymd);
  const nowMs = Date.now();
  const stmts = [];
  const nowIso = new Date().toISOString();
  for (const row of rows) {
    const misc = parseMisc(row.misc);
    const next = pruneExpiredMisc(misc, nowMs);
    if (next.length !== misc.length) {
      row.misc = JSON.stringify(next);
      stmts.push(context.env.DB.prepare(
        "UPDATE my_orders SET misc = ?, updated_at = ? WHERE staff_id = ? AND ymd = ?"
      ).bind(row.misc, nowIso, staffId, row.ymd));
    }
  }
  if (stmts.length) await context.env.DB.batch(stmts);
  return json({ ok: true, staff_id: staffId, orders: formatRows(rows) });
}

export async function onRequestPut(context) {
  let body;
  try { body = await context.request.json(); } catch { return json({ error: "格式不正確" }, 400); }

  const sess = await getSession(context.env, context.request);
  const asWriter = writeKeyOk(context.request, context.env);
  if (!sess && !asWriter) return json({ error: "未授權" }, 401);

  const ymd = normYmd(body.ymd || body.date);
  if (!ymd) return json({ error: "日期不正確" }, 400);
  const hasFlights = Object.prototype.hasOwnProperty.call(body, "flights");
  const hasMisc = Object.prototype.hasOwnProperty.call(body, "misc");
  const hasDrop = Object.prototype.hasOwnProperty.call(body, "drop");
  if (!hasFlights && !hasMisc && !hasDrop) return json({ error: "航班名單不正確" }, 400);
  const flights = hasFlights ? cleanFlights(body.flights) : undefined;
  if (hasFlights && !flights) return json({ error: "航班名單不正確" }, 400);
  const dropFlights = hasDrop ? cleanFlights(body.drop) : undefined;
  if (hasDrop && !dropFlights) return json({ error: "航班名單不正確" }, 400);
  const defaultMiscAt = body.misc_at || (asWriter ? new Date().toISOString() : "");
  const misc = hasMisc ? cleanMisc(body.misc, defaultMiscAt) : undefined;
  if (hasMisc && !misc) return json({ error: "雜項不正確" }, 400);

  let staffId;
  if (asWriter) {
    staffId = normalizeStaffId(body.staff_id);
    if (!staffId) return json({ error: "職員編號不正確" }, 400);
  } else {
    staffId = sess.staff_id;
  }

  const shareWith = asWriter ? cleanStaffIds(body.share_with) : [];
  if (asWriter && body.remove === true) {
    if (!hasFlights || !flights.length) return json({ error: "航班名單不正確" }, 400);
    // Strip ymd so the flight is removed from every day for this staff.
    await removeFlightsFromStaff(context.env.DB, staffId, flights.map((f) => ({ flight: f.flight, dir: f.dir })));
    const row = await context.env.DB.prepare(
      "SELECT flights, misc, updated_at FROM my_orders WHERE staff_id = ? AND ymd = ?"
    ).bind(staffId, ymd).first();
    let remaining = [];
    try { remaining = JSON.parse((row && row.flights) || "[]"); } catch { remaining = []; }
    if (!Array.isArray(remaining)) remaining = [];
    const miscOut = parseMisc(row && row.misc);
    return json({
      ok: true,
      staff_id: staffId,
      ymd,
      flights: remaining,
      misc: miscOut,
      updated_at: (row && row.updated_at) || new Date().toISOString(),
      removed: true,
    });
  }
  const replace = body.replace === true;
  const mergeWriter = asWriter && body.merge === true && !replace;
  const saved = await upsertOrder(context.env.DB, staffId, ymd, {
    flights,
    misc,
    keepInfo: !asWriter,
    mergeMiscWithPrev: !asWriter,
    protectExisting: !asWriter && !replace,
    mergeWriter,
    dropFlights,
  });
  if (asWriter && hasFlights && flights && flights.length) {
    // Unassign only the flights in this write, not the staff member's whole day.
    await unassignFlightsFromOthers(context.env.DB, staffId, ymd, flights, shareWith);
  }
  return json({ ok: true, staff_id: staffId, ymd, flights: saved.flights, misc: saved.misc, updated_at: saved.at });
}

export async function onRequestDelete(context) {
  const sess = await getSession(context.env, context.request);
  if (!sess) return json({ error: "未登入" }, 401);
  const ymd = normYmd(new URL(context.request.url).searchParams.get("ymd"));
  await ensureSchema(context.env.DB);
  if (ymd) {
    await context.env.DB.prepare("DELETE FROM my_orders WHERE staff_id = ? AND ymd = ?").bind(sess.staff_id, ymd).run();
  } else {
    await context.env.DB.prepare("DELETE FROM my_orders WHERE staff_id = ?").bind(sess.staff_id).run();
  }
  return json({ ok: true, staff_id: sess.staff_id, ymd: ymd || null });
}

export async function onRequest(context) {
  const method = context.request.method;
  if (method === "GET") return onRequestGet(context);
  if (method === "PUT") return onRequestPut(context);
  if (method === "DELETE") return onRequestDelete(context);
  return json({ error: "Method Not Allowed" }, 405, { Allow: "GET, PUT, DELETE" });
}

export { mergeMisc, cleanMisc, parseMisc };
