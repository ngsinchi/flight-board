import { getSession, json, randomToken } from "../_lib/auth.js";
import { nameOf } from "../_lib/staff-names.js";
import { removeFlightsFromStaff } from "./myorder.js";

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

const ACTIONS = {
  done: { label: "DONE", place: "after" },
  go: { label: "GO", place: "after", dir: "dep" },
  sby: { label: "SBY", place: "before", dir: "arr" },
  signed: { label: "Signed", place: "after", dir: "arr" },
  no_sup: { label: "No Sup and all correct", place: "after", dir: "arr" },
  go_vcc: { label: "GO VCC", place: "after", dir: "arr" },
  ev_key: { label: "EV/Key", place: "after" }
};

function normAction(raw) {
  const a = String(raw || "done").toLowerCase().trim().replace(/-/g, "_").replace(/\s+/g, "_");
  if (a === "govcc") return "go_vcc";
  if (a === "nosup") return "no_sup";
  return ACTIONS[a] ? a : "";
}

function inferAction(action, body) {
  const a = normAction(action);
  if (a) return a;
  const text = String(body || "");
  if (/No Sup and all correct/i.test(text)) return "no_sup";
  if (/GO VCC/.test(text)) return "go_vcc";
  if (/^SBY\s/m.test(text)) return "sby";
  if (/\sSigned\s*$/m.test(text)) return "signed";
  if (/\sGO\s*$/m.test(text)) return "go";
  if (/MyEV/.test(text) && /MyKey/.test(text)) return "ev_key";
  return "done";
}


const AIRLINE_CODES = ["CX","LH","LD","LX","3S","NH","C6","MS","6E","CK","MU"];
const ICAO_TO_IATA = {CPA:"CX",DLH:"LH",GEC:"LH",AHK:"LD",DHK:"LD",SWR:"LX",BOX:"3S",ANA:"NH",MFX:"C6",MSR:"MS",CKK:"CK",CES:"MU",IGO:"6E"};

function flightKey(no) {
  let s = normFlight(no);
  if (!s) return "";
  for (const icao of Object.keys(ICAO_TO_IATA)) {
    if (s.startsWith(icao) && s.length > icao.length && /\d/.test(s.charAt(icao.length))) {
      s = ICAO_TO_IATA[icao] + s.slice(icao.length);
      break;
    }
  }
  const codes = AIRLINE_CODES.slice().sort((a, b) => b.length - a.length);
  let al = "";
  for (const a of codes) {
    if (s.startsWith(a) && (s.length === a.length || (s.length > a.length && /\d/.test(s.charAt(a.length))))) {
      al = a;
      break;
    }
  }
  if (!al) return s;
  const m = s.slice(al.length).match(/^0*(\d+)(.*)$/);
  return m ? al + m[1] + (m[2] || "") : s;
}

function lockActionOf(action) {
  if (action === "signed" || action === "no_sup") return "signed_or_no_sup";
  return action;
}

function parseJobFlights(row) {
  try { return JSON.parse((row && row.flights) || "[]"); } catch { return []; }
}

function sameLockedFlight(a, b) {
  return flightKey(a && a.flight) === flightKey(b && b.flight)
    && String((a && a.dir) || "") === String((b && b.dir) || "")
    && String((a && a.ymd) || "") === String((b && b.ymd) || "");
}

function isActiveLockStatus(status) {
  return status === "pending" || status === "sending" || status === "sent";
}

function latestLockJob(rows, rec, action) {
  const want = lockActionOf(action);
  let latest = null;
  for (const row of rows || []) {
    const act = inferAction(row.action, row.body);
    if (lockActionOf(act) !== want) continue;
    const flights = parseJobFlights(row);
    if (!flights.some((f) => sameLockedFlight(f, rec))) continue;
    if (!latest) {
      latest = row;
      continue;
    }
    const ru = String(row.updated_at || row.created_at || "");
    const lu = String(latest.updated_at || latest.created_at || "");
    if (ru > lu || (ru === lu && String(row.created_at || "") > String(latest.created_at || ""))) {
      latest = row;
    }
  }
  return latest;
}

function flightIsLockedByJobs(rows, rec, action) {
  const latest = latestLockJob(rows, rec, action);
  return !!(latest && isActiveLockStatus(latest.status));
}

function lastTwoLetters(raw) {
  const letters = String(raw || "").toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length >= 2 ? letters.slice(-2) : "";
}

function normFlight(raw) {
  return String(raw || "").replace(/\s+/g, "").toUpperCase();
}

function cleanFlights(input, action) {
  if (!Array.isArray(input)) return { error: "格式不正確" };
  const spec = ACTIONS[action];
  if (!spec) return { error: "動作不正確" };
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (!item) continue;
    const flight = normFlight(typeof item === "string" ? item : item.flight);
    if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(flight)) continue;
    let dir = String((typeof item === "string" ? "" : (item.dir || "")) || "").toLowerCase();
    if (dir !== "arr" && dir !== "dep") dir = spec.dir || "";
    if (spec.dir && dir && dir !== spec.dir) continue;
    if (spec.dir) dir = spec.dir;
    if (!dir) continue;
    const ymd = String((typeof item === "string" ? "" : (item.ymd || item.date)) || "").trim();
    const rec = { flight, dir };
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) rec.ymd = ymd;
    if (action === "done" && dir === "dep") {
      const reg = lastTwoLetters(typeof item === "string" ? "" : (item.reg || item.ac || ""));
      if (!reg) return { error: "請填機身編號尾兩個英文字" };
      rec.reg = reg;
    }
    if (action === "sby") {
      const stand = cleanStand(typeof item === "string" ? "" : (item.stand || item.st || ""));
      if (!stand) return { error: "請填停機位" };
      rec.stand = stand;
    }
    const key = (rec.ymd || "") + "|" + dir + "|" + flight;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return { flights: out };
}

function cleanStand(raw) {
  const s = String(raw || "").replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  if (!s || s === "—" || s === "-") return "";
  const compact = s.replace(/ /g, "");
  return /^[A-Z0-9][A-Z0-9/-]{0,15}$/.test(compact) ? compact : "";
}

function clickTimeHkt(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const hh = String(parts.find((p) => p.type === "hour")?.value || "").padStart(2, "0");
  const mm = String(parts.find((p) => p.type === "minute")?.value || "").padStart(2, "0");
  return `${hh}:${mm}`;
}

function nameHeader(name, nowMs = Date.now()) {
  return `*_${name}_*：${clickTimeHkt(nowMs)}`;
}

function buildText(flights, name, action, nowMs = Date.now()) {
  const lines = [nameHeader(name, nowMs)];
  if (action === "no_sup") {
    flights.forEach((f) => lines.push(f.flight));
    lines.push("No Sup and all correct");
    return lines.join("\n");
  }
  if (action === "done") {
    const deps = flights.filter((f) => f.dir === "dep");
    const arrs = flights.filter((f) => f.dir !== "dep");
    deps.forEach((f) => {
      lines.push(f.reg ? `${f.flight} ${f.reg}` : f.flight);
    });
    arrs.forEach((f) => lines.push(`${f.flight} DONE`));
    return lines.join("\n");
  }
  const spec = ACTIONS[action];
  flights.forEach((f) => {
    if (action === "sby") lines.push(f.stand ? `SBY ${f.flight} ${f.stand}` : `SBY ${f.flight}`);
    else lines.push(spec.place === "before" ? `${spec.label} ${f.flight}` : `${f.flight} ${spec.label}`);
  });
  return lines.join("\n");
}

export { nameHeader, buildText, inferAction, clickTimeHkt };

export async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS escort_done_jobs (
      id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL,
      body TEXT NOT NULL,
      flights TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  try {
    await db.prepare("ALTER TABLE escort_done_jobs ADD COLUMN action TEXT").run();
  } catch (e) {}
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_escort_done_jobs_status_created ON escort_done_jobs (status, created_at)"
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_escort_done_jobs_staff_updated ON escort_done_jobs (staff_id, updated_at)"
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_escort_done_jobs_created ON escort_done_jobs (created_at)"
  ).run();
  await pruneOldEscortJobs(db);
}

export const ESCORT_JOB_RETENTION_DAYS = 60;

export function escortJobCutoffIso(nowMs = Date.now()) {
  return new Date(nowMs - ESCORT_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export async function pruneOldEscortJobs(db, nowMs = Date.now()) {
  if (!db) return;
  const cutoff = escortJobCutoffIso(nowMs);
  await db.prepare(
    "DELETE FROM escort_done_jobs WHERE created_at < ? AND IFNULL(updated_at, created_at) < ?"
  ).bind(cutoff, cutoff).run();
}

function formatJob(row) {
  if (!row) return null;
  let flights = [];
  try { flights = JSON.parse(row.flights || "[]"); } catch { flights = []; }
  return {
    id: row.id,
    staff_id: row.staff_id,
    text: row.body,
    flights,
    action: inferAction(row.action, row.body),
    status: row.status,
    error: row.error || "",
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function onRequestPost(context) {
  const sess = await getSession(context.env, context.request);
  if (!sess) return json({ error: "未登入" }, 401);
  let body;
  try { body = await context.request.json(); } catch { return json({ error: "格式不正確" }, 400); }

  const action = normAction(body && body.action);
  if (!action) return json({ error: "動作不正確" }, 400);
  if (action === "ev_key") return json({ error: "請用確認 EV/Key" }, 400);
  const cleaned = cleanFlights(body.flights, action);
  if (cleaned && cleaned.error) return json({ error: cleaned.error }, 400);
  const flights = cleaned && cleaned.flights;
  if (!flights || !flights.length) {
    const want = ACTIONS[action].dir;
    return json({ error: want === "arr" ? "請先剔入口航班" : "請先剔離港航班" }, 400);
  }
  const name = nameOf(sess.staff_id);
  if (!name) return json({ error: "未有呢個職員嘅名稱對照" }, 400);

  await ensureSchema(context.env.DB);
  let accepted = flights;
  if (action !== "done") {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const prior = (await context.env.DB.prepare(
      `SELECT * FROM escort_done_jobs
       WHERE staff_id = ? AND (created_at >= ? OR updated_at >= ?)
       ORDER BY updated_at DESC LIMIT 300`
    ).bind(sess.staff_id, since, since).all()).results || [];
    accepted = flights.filter((f) => !flightIsLockedByJobs(prior, f, action));
    if (!accepted.length) {
      return json({ error: "所選航班已經交過呢個動作" }, 409);
    }
  }

  const text = buildText(accepted, name, action);
  const id = await randomToken();
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO escort_done_jobs (id, staff_id, body, flights, status, error, created_at, updated_at, action)
     VALUES (?, ?, ?, ?, 'pending', '', ?, ?, ?)`
  ).bind(id, sess.staff_id, text, JSON.stringify(accepted), now, now, action).run();
  return json({ ok: true, id, text, action, status: "pending", flights: accepted });
}

export async function onRequestGet(context) {
  const request = context.request;
  const env = context.env;
  const asWriter = writeKeyOk(request, env);
  const sess = await getSession(env, request);
  if (!sess && !asWriter) return json({ error: "未授權" }, 401);

  await ensureSchema(env.DB);
  const url = new URL(request.url);
  const id = String(url.searchParams.get("id") || "").trim();
  const status = String(url.searchParams.get("status") || "").trim();

  if (asWriter && !id && (status === "pending" || status === "sending")) {
    const rows = (await env.DB.prepare(
      "SELECT * FROM escort_done_jobs INDEXED BY idx_escort_done_jobs_status_created WHERE status = ? ORDER BY created_at ASC LIMIT 20"
    ).bind(status).all()).results || [];
    return json({ ok: true, jobs: rows.map(formatJob) });
  }

  if (sess && url.searchParams.get("mine") === "1") {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const rows = (await env.DB.prepare(
      "SELECT * FROM escort_done_jobs INDEXED BY idx_escort_done_jobs_staff_updated WHERE staff_id = ? AND status IN ('pending', 'sending', 'sent') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 200"
    ).bind(sess.staff_id, since).all()).results || [];
    return json({ ok: true, jobs: rows.map(formatJob) });
  }

  if (!id) return json({ error: "缺少編號" }, 400);
  const row = await env.DB.prepare("SELECT * FROM escort_done_jobs WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "找不到呢項" }, 404);
  if (!asWriter && row.staff_id !== sess.staff_id) return json({ error: "找不到呢項" }, 404);
  return json({ ok: true, ...formatJob(row) });
}

export async function onRequestPatch(context) {
  if (!writeKeyOk(context.request, context.env)) return json({ error: "未授權" }, 401);
  let body;
  try { body = await context.request.json(); } catch { return json({ error: "格式不正確" }, 400); }
  const id = String(body.id || "").trim();
  const status = String(body.status || "").trim();
  const error = String(body.error || "").slice(0, 300);
  if (!id) return json({ error: "缺少編號" }, 400);
  if (!["sending", "sent", "error"].includes(status)) return json({ error: "狀態不正確" }, 400);

  await ensureSchema(context.env.DB);
  const now = new Date().toISOString();
  let sql, binds;
  if (status === "sending") {
    sql = `UPDATE escort_done_jobs SET status = ?, error = '', updated_at = ?
           WHERE id = ? AND status IN ('pending', 'sending')`;
    binds = [status, now, id];
  } else if (status === "sent") {
    sql = `UPDATE escort_done_jobs SET status = ?, error = '', updated_at = ?
           WHERE id = ? AND status IN ('pending', 'sending')`;
    binds = [status, now, id];
  } else {
    sql = `UPDATE escort_done_jobs SET status = ?, error = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'sending')`;
    binds = [status, error, now, id];
  }
  const res = await context.env.DB.prepare(sql).bind(...binds).run();
  if (!res.meta || !res.meta.changes) return json({ error: "未能更新" }, 409);
  const row = await context.env.DB.prepare("SELECT * FROM escort_done_jobs WHERE id = ?").bind(id).first();
  const job = formatJob(row);
  if (status === "sent" && job && job.action === "done") {
    await removeFlightsFromStaff(context.env.DB, job.staff_id, job.flights);
  }
  return json({ ok: true, ...job });
}

export async function onRequest(context) {
  const method = context.request.method;
  if (method === "POST") return onRequestPost(context);
  if (method === "GET") return onRequestGet(context);
  if (method === "PATCH") return onRequestPatch(context);
  return json({ error: "Method Not Allowed" }, 405, { Allow: "GET, POST, PATCH" });
}
