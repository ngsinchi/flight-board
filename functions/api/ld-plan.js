import { getSession, json } from "../_lib/auth.js";

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
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
    }
  }
  m = s.match(/^(\d{3,4})$/);
  if (m) {
    const t = m[1].padStart(4, "0");
    const h = Number(t.slice(0, 2)), min = Number(t.slice(2));
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
    }
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

function normDir(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "arr" || s === "arrival" || s === "入口" || s === "a") return "arr";
  if (s === "dep" || s === "departure" || s === "出口" || s === "d") return "dep";
  return "";
}

function normStand(raw) {
  const s = String(raw || "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]\d{1,4}$/.test(s) ? s : "";
}

function normReg(raw) {
  const s = String(raw || "").replace(/\s+/g, "").toUpperCase();
  const m = s.match(/^B-?([A-Z]{3})$/);
  return m ? "B-" + m[1] : "";
}

function cleanRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ymd = normYmd(raw.ymd || raw.date);
  const dir = normDir(raw.dir);
  const flight = flightKey(raw.flight);
  const std = normTime(raw.std || raw.sta || raw.time);
  if (!ymd || !dir || !flight || !std) return null;
  if (!/^LD\d+$/.test(flight) && !/^[A-Z0-9]{2,3}\d+[A-Z]?$/.test(flight)) return null;
  const row = { ymd, dir, flight, std };
  const etd = normTime(raw.etd || raw.eta);
  if (etd && etd !== std) row.etd = etd;
  const st = normStand(raw.st || raw.stand || raw.bay);
  if (st) row.st = st;
  const reg = normReg(raw.reg);
  if (reg) row.reg = reg;
  return row;
}

async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ld_plans (
      ymd TEXT NOT NULL,
      dir TEXT NOT NULL,
      flight TEXT NOT NULL,
      std TEXT,
      etd TEXT,
      st TEXT,
      reg TEXT,
      source TEXT,
      updated_at TEXT,
      PRIMARY KEY (ymd, dir, flight)
    )`
  ).run();
}

function formatRow(row) {
  const out = {
    ymd: row.ymd,
    dir: row.dir,
    flight: row.flight,
    std: row.std || "",
  };
  if (row.etd) out.etd = row.etd;
  if (row.st) out.st = row.st;
  if (row.reg) out.reg = row.reg;
  if (row.source) out.source = row.source;
  if (row.updated_at) out.updated_at = row.updated_at;
  return out;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const sess = await getSession(env, request);
  if (!sess && !writeKeyOk(request, env)) return json({ error: "未授權" }, 401);
  if (!env.DB) return json({ error: "未設定資料庫" }, 500);
  await ensureSchema(env.DB);
  const url = new URL(request.url);
  const ymd = normYmd(url.searchParams.get("ymd"));
  const dir = normDir(url.searchParams.get("dir"));
  let sql = "SELECT ymd, dir, flight, std, etd, st, reg, source, updated_at FROM ld_plans";
  const binds = [];
  const where = [];
  if (ymd) { where.push("ymd = ?"); binds.push(ymd); }
  if (dir) { where.push("dir = ?"); binds.push(dir); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY ymd, dir, std, flight";
  const rows = (await env.DB.prepare(sql).bind(...binds).all()).results || [];
  return json({ ok: true, rows: rows.map(formatRow) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!writeKeyOk(request, env)) return json({ error: "未授權" }, 401);
  if (!env.DB) return json({ error: "未設定資料庫" }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: "無效資料" }, 400); }
  const list = Array.isArray(body) ? body : (body && body.rows);
  if (!Array.isArray(list) || !list.length) return json({ error: "沒有列" }, 400);
  if (list.length > 200) return json({ error: "列數過多" }, 400);
  const source = String((body && body.source) || "").slice(0, 120);
  const now = new Date().toISOString();
  const cleaned = [];
  for (const raw of list) {
    const row = cleanRow(raw);
    if (row) cleaned.push(row);
  }
  if (!cleaned.length) return json({ error: "沒有有效列" }, 400);
  await ensureSchema(env.DB);
  const stmts = cleaned.map((row) =>
    env.DB.prepare(
      `INSERT INTO ld_plans (ymd, dir, flight, std, etd, st, reg, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ymd, dir, flight) DO UPDATE SET
         std = excluded.std,
         etd = excluded.etd,
         st = excluded.st,
         reg = excluded.reg,
         source = excluded.source,
         updated_at = excluded.updated_at`
    ).bind(
      row.ymd, row.dir, row.flight,
      row.std || "", row.etd || "", row.st || "", row.reg || "",
      source, now
    )
  );
  await env.DB.batch(stmts);
  return json({ ok: true, count: cleaned.length, rows: cleaned, updated_at: now });
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method === "GET") return onRequestGet(context);
  if (method === "POST" || method === "PUT") return onRequestPost(context);
  return json({ error: "方法不支援" }, 405);
}
