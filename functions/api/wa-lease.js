import { json, randomToken } from "../_lib/auth.js";

export const LEASE_ID = "escort";
export const PREFERRED = "home";
export const TTL_MS = 90_000;
export const RENEW_INTERVAL_MS = 30_000;
export const DOWN_STATUSES = Object.freeze(["qr", "disconnected", "yielded"]);
export const NODES = Object.freeze(["home", "box"]);

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

export function isDownStatus(status) {
  return DOWN_STATUSES.includes(String(status || ""));
}

export function leaseIsExpired(row, now) {
  if (!row || !row.holder) return true;
  return Number(row.expires_at || 0) <= now;
}

export function sanitizeCursor(raw) {
  if (!raw) return null;
  let src = raw;
  if (typeof raw === "string") {
    try { src = JSON.parse(raw); } catch { return null; }
  }
  if (typeof src !== "object") return null;
  const seen = [];
  const seenSet = new Set();
  if (Array.isArray(src.seen)) {
    for (const item of src.seen) {
      const s = String(item || "");
      if (!s || s.length > 128 || seenSet.has(s)) continue;
      seenSet.add(s);
      seen.push(s);
    }
  }
  const bubbles = {};
  const bsrc = src.bubbles && typeof src.bubbles === "object" && !Array.isArray(src.bubbles) ? src.bubbles : {};
  for (const k of Object.keys(bsrc)) {
    if (!k || k.length > 128) continue;
    const v = bsrc[k];
    if (v == null) continue;
    const sv = String(v);
    if (!sv || sv.length > 128) continue;
    bubbles[k] = sv;
  }
  const bubbleKeys = Object.keys(bubbles);
  if (bubbleKeys.length > 500) {
    for (const k of bubbleKeys.slice(0, bubbleKeys.length - 500)) delete bubbles[k];
  }
  return { seen: seen.slice(-500), bubbles };
}

export function canAcquire(row, { requester, token, now } = {}) {
  if (!NODES.includes(requester)) return false;
  if (!row || !row.holder) return true;
  if (Number(row.expires_at || 0) <= now) return true;
  if (isDownStatus(row.status)) return true;
  const provided = String(token || "");
  if (row.holder === requester && provided && provided === String(row.token || "")) return true;
  if (requester === PREFERRED && requester === "home" && row.holder === "box") return true;
  return false;
}

export function formatStatus(row, now) {
  const cursor = row && row.last_cursor ? sanitizeCursor(row.last_cursor) : null;
  const holder = row && row.holder ? String(row.holder) : "";
  const expiresAt = row ? Number(row.expires_at || 0) : 0;
  const status = row && row.status ? String(row.status) : "";
  const expired = !holder || expiresAt <= now || isDownStatus(status);
  return {
    ok: true,
    id: LEASE_ID,
    holder,
    expires_at: expiresAt,
    updated_at: row ? Number(row.updated_at || 0) : 0,
    status,
    preferred: (row && row.preferred) || PREFERRED,
    reason: (row && row.reason) || "",
    expired,
    held: Boolean(holder) && !expired && status === "ok" && expiresAt > now,
    cursor,
  };
}

async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS wa_reader_lease (
      id TEXT PRIMARY KEY,
      holder TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL DEFAULT '',
      expires_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      last_cursor TEXT,
      reason TEXT,
      preferred TEXT NOT NULL DEFAULT 'home'
    )`
  ).run();
}

async function seedRow(db) {
  await db.prepare(
    `INSERT OR IGNORE INTO wa_reader_lease
      (id, holder, token, expires_at, updated_at, status, last_cursor, reason, preferred)
     VALUES (?, '', '', 0, 0, '', NULL, '', ?)`
  ).bind(LEASE_ID, PREFERRED).run();
}

async function readRow(db) {
  try {
    return await db.prepare("SELECT * FROM wa_reader_lease WHERE id = ?").bind(LEASE_ID).first();
  } catch {
    return null;
  }
}

function parseCursorBind(cursor) {
  const clean = sanitizeCursor(cursor);
  return clean ? JSON.stringify(clean) : null;
}

function unauthorized() {
  return json({ error: "未授權" }, 401);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!writeKeyOk(request, env)) return unauthorized();
  const now = Date.now();
  const row = env.DB ? await readRow(env.DB) : null;
  return json(formatStatus(row, now));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!writeKeyOk(request, env)) return unauthorized();
  if (!env.DB) return json({ error: "未設定資料庫" }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "格式不正確" }, 400); }
  body = body || {};

  const action = String(body.action || "").toLowerCase().trim().replace(/-/g, "_");
  const requester = String(body.node || body.holder || "").toLowerCase().trim();
  const providedToken = String(body.token || "");
  const reason = String(body.reason || "").slice(0, 200);
  const cursorJson = parseCursorBind(body.cursor);
  const now = Date.now();

  if (!NODES.includes(requester)) return json({ error: "節點不正確" }, 400);
  if (!["acquire", "renew", "yield", "mark", "mark_down"].includes(action)) {
    return json({ error: "動作不正確" }, 400);
  }

  await ensureSchema(env.DB);
  await seedRow(env.DB);

  if (action === "acquire") {
    const newToken = await randomToken();
    const expiresAt = now + TTL_MS;
    const result = await env.DB.prepare(
      `UPDATE wa_reader_lease
       SET holder = ?,
           token = ?,
           expires_at = ?,
           updated_at = ?,
           status = 'ok',
           reason = ?,
           last_cursor = CASE WHEN ? IS NOT NULL THEN ? ELSE last_cursor END,
           preferred = ?
       WHERE id = ?
         AND (
           IFNULL(holder, '') = ''
           OR IFNULL(expires_at, 0) <= ?
           OR status IN ('qr', 'disconnected', 'yielded')
           OR (holder = ? AND token = ? AND IFNULL(token, '') != '')
           OR (? = 'home' AND IFNULL(holder, '') = 'box')
         )`
    ).bind(
      requester,
      newToken,
      expiresAt,
      now,
      reason,
      cursorJson,
      cursorJson,
      PREFERRED,
      LEASE_ID,
      now,
      requester,
      providedToken,
      requester
    ).run();
    if (!result || !result.meta || !result.meta.changes) {
      const row = await readRow(env.DB);
      return json({ ...formatStatus(row, now), ok: false, error: "未能取得租約" }, 409);
    }
    const row = await readRow(env.DB);
    return json({ ...formatStatus(row, now), ok: true, token: newToken, expires_at: expiresAt });
  }

  if (action === "renew") {
    if (!providedToken) return json({ error: "缺少 token" }, 400);
    const expiresAt = now + TTL_MS;
    const result = await env.DB.prepare(
      `UPDATE wa_reader_lease
       SET expires_at = ?,
           updated_at = ?,
           last_cursor = CASE WHEN ? IS NOT NULL THEN ? ELSE last_cursor END
       WHERE id = ?
         AND holder = ?
         AND token = ?
         AND status = 'ok'
         AND IFNULL(expires_at, 0) > ?`
    ).bind(expiresAt, now, cursorJson, cursorJson, LEASE_ID, requester, providedToken, now).run();
    if (!result || !result.meta || !result.meta.changes) {
      const row = await readRow(env.DB);
      return json({ ...formatStatus(row, now), ok: false, error: "未能續期" }, 409);
    }
    const row = await readRow(env.DB);
    return json({ ...formatStatus(row, now), ok: true, token: providedToken, expires_at: expiresAt });
  }

  let markStatus = "yielded";
  if (action === "yield") {
    markStatus = "yielded";
  } else {
    markStatus = String(body.status || "disconnected").toLowerCase().trim();
    if (!isDownStatus(markStatus)) return json({ error: "狀態不正確" }, 400);
  }
  if (!providedToken) return json({ error: "缺少 token" }, 400);
  const result = await env.DB.prepare(
    `UPDATE wa_reader_lease
     SET status = ?,
         holder = '',
         token = '',
         expires_at = 0,
         updated_at = ?,
         reason = ?
     WHERE id = ?
       AND holder = ?
       AND token = ?`
  ).bind(markStatus, now, reason || markStatus, LEASE_ID, requester, providedToken).run();
  if (!result || !result.meta || !result.meta.changes) {
    const row = await readRow(env.DB);
    return json({ ...formatStatus(row, now), ok: false, error: "未能釋放租約" }, 409);
  }
  const row = await readRow(env.DB);
  return json({ ...formatStatus(row, now), ok: true });
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method === "GET") return onRequestGet(context);
  if (method === "POST") return onRequestPost(context);
  return json({ error: "方法不正確" }, 405);
}
