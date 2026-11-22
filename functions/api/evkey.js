import { getSession, json, randomToken } from "../_lib/auth.js";
import { nameOf } from "../_lib/staff-names.js";
import { ensureSchema as ensureDoneSchema, nameHeader } from "./done.js";

export const EVS = ["989", "987", "985", "981", "978", "977"];
export const KEYS = ["1", "2", "3", "4", "5", "NA"];

export function evkeyText(name, ev, key, nowMs = Date.now()) {
  return `${nameHeader(name, nowMs)}\nMyEV🚗${ev} MyKey🔑${key}`;
}

export async function ensureEvKeySchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS evkey_claims (
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, value)
    )`
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_evkey_claims_staff ON evkey_claims (staff_id)"
  ).run();
}

export async function pruneExpiredClaims(db) {
  // Claims stay with the last confirmer until another staff claims that EV/Key.
  // Logout and session expiry must not release them.
  return;
}

export async function releaseEvKeyClaims(db, staffId) {
  await ensureEvKeySchema(db);
  const id = String(staffId || "");
  if (!id) return;
  await db.prepare("DELETE FROM evkey_claims WHERE staff_id = ?").bind(id).run();
}

export async function mineOf(db, staffId) {
  const rows = (await db.prepare(
    "SELECT kind, value FROM evkey_claims WHERE staff_id = ?"
  ).bind(String(staffId || "")).all()).results || [];
  const mine = { ev: "", key: "" };
  for (const row of rows) {
    if (row.kind === "ev") mine.ev = String(row.value || "");
    if (row.kind === "key") mine.key = String(row.value || "");
  }
  return mine;
}

export async function confirmEvKeyClaims(db, staffId, ev, key) {
  const now = new Date().toISOString();
  const id = String(staffId);
  await pruneExpiredClaims(db);
  const beforeEv = (await db.prepare(
    "SELECT staff_id FROM evkey_claims WHERE kind = 'ev' AND value = ?"
  ).bind(ev).first());
  const beforeKey = (await db.prepare(
    "SELECT staff_id FROM evkey_claims WHERE kind = 'key' AND value = ?"
  ).bind(key).first());
  await db.prepare("DELETE FROM evkey_claims WHERE staff_id = ?").bind(id).run();
  await db.prepare(
    `INSERT OR REPLACE INTO evkey_claims (kind, value, staff_id, updated_at) VALUES ('ev', ?, ?, ?)`
  ).bind(ev, id, now).run();
  await db.prepare(
    `INSERT OR REPLACE INTO evkey_claims (kind, value, staff_id, updated_at) VALUES ('key', ?, ?, ?)`
  ).bind(key, id, now).run();
  return {
    mine: { ev, key },
    stolen: {
      ev: beforeEv && beforeEv.staff_id && beforeEv.staff_id !== id ? beforeEv.staff_id : "",
      key: beforeKey && beforeKey.staff_id && beforeKey.staff_id !== id ? beforeKey.staff_id : ""
    }
  };
}

function validEv(v) { return EVS.indexOf(String(v || "")) >= 0; }
function validKey(v) { return KEYS.indexOf(String(v || "")) >= 0; }

async function requireSession(context) {
  const sess = await getSession(context.env, context.request);
  if (!sess) return { error: json({ error: "未登入" }, 401) };
  await ensureEvKeySchema(context.env.DB);
  return { sess };
}

export async function onRequestGet(context) {
  const got = await requireSession(context);
  if (got.error) return got.error;
  await pruneExpiredClaims(context.env.DB);
  const mine = await mineOf(context.env.DB, got.sess.staff_id);
  return json({ ok: true, mine });
}

export async function onRequestDelete(context) {
  const got = await requireSession(context);
  if (got.error) return got.error;
  await releaseEvKeyClaims(context.env.DB, got.sess.staff_id);
  return json({ ok: true, mine: { ev: "", key: "" } });
}

export async function onRequestPost(context) {
  const got = await requireSession(context);
  if (got.error) return got.error;
  let body;
  try { body = await context.request.json(); } catch { return json({ error: "格式不正確" }, 400); }
  const ev = String((body && body.ev) || "");
  const key = String((body && body.key) || "");
  if (!validEv(ev) || !validKey(key)) return json({ error: "請先揀 MyEV 同 MyKey" }, 400);
  const name = nameOf(got.sess.staff_id);
  if (!name) return json({ error: "未有呢個職員嘅名稱對照" }, 400);

  const result = await confirmEvKeyClaims(context.env.DB, got.sess.staff_id, ev, key);
  const text = evkeyText(name, ev, key);
  await ensureDoneSchema(context.env.DB);
  const id = await randomToken();
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO escort_done_jobs (id, staff_id, body, flights, status, error, created_at, updated_at, action)
     VALUES (?, ?, ?, '[]', 'pending', '', ?, ?, 'ev_key')`
  ).bind(id, got.sess.staff_id, text, now, now).run();
  return json({ ok: true, id, text, action: "ev_key", status: "pending", mine: result.mine, stolen: result.stolen });
}

export async function onRequest(context) {
  const method = context.request.method;
  if (method === "GET") return onRequestGet(context);
  if (method === "POST") return onRequestPost(context);
  if (method === "DELETE") return onRequestDelete(context);
  return json({ error: "Method Not Allowed" }, 405, { Allow: "GET, POST, DELETE" });
}
