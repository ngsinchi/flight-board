export const COOKIE = "hkg_fb_session";
export const MAX_AGE = 7 * 24 * 60 * 60;
export const IDLE_AGE = 120 * 60;
const PBKDF2_ITERS = 100000;
let sessionSchemaReady = false;

export function resetSessionSchemaCache() {
  sessionSchemaReady = false;
}

export function isIdleExpired(lastActiveAt, nowMs = Date.now(), idleSec = IDLE_AGE) {
  const last = Date.parse(lastActiveAt || "");
  return !Number.isFinite(last) || nowMs - last >= idleSec * 1000;
}

export async function ensureSessionSchema(env) {
  if (!env || !env.DB || sessionSchemaReady) return;
  try {
    await env.DB.prepare("ALTER TABLE sessions ADD COLUMN last_active_at TEXT").run();
  } catch {}
  try {
    await env.DB.prepare(
      "UPDATE sessions SET last_active_at = ? WHERE last_active_at IS NULL OR last_active_at = ''"
    ).bind(new Date().toISOString()).run();
  } catch {}
  sessionSchemaReady = true;
}

export function json(data, status = 200, extra = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  for (const [k, v] of Object.entries(extra)) {
    if (k === "Set-Cookie") headers.append("Set-Cookie", v);
    else headers.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function parseCookies(request) {
  const raw = request.headers.get("Cookie") || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function sessionCookie(token, maxAge) {
  let c = `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/`;
  if (typeof maxAge === "number") c += `; Max-Age=${maxAge}`;
  return c;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64Url(bytes) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64Url(bytes);
}

async function pbkdf2(password, salt, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERS);
  return `pbkdf2$sha256$${PBKDF2_ITERS}$${b64(salt)}$${b64(hash)}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  try {
    const salt = fromB64(parts[3]);
    const expected = fromB64(parts[4]);
    const actual = await pbkdf2(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function normalizeStaffId(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{7}$/.test(s)) return null;
  return s;
}

export async function getSession(env, request) {
  const token = parseCookies(request)[COOKIE];
  if (!token || !env.DB) return null;
  await ensureSessionSchema(env);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const cap = new Date(nowMs + MAX_AGE * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT s.token, s.staff_id, s.expires_at, s.last_active_at, u.is_admin
     FROM sessions s
     JOIN users u ON u.staff_id = s.staff_id
     WHERE s.token = ? AND s.expires_at > ? AND s.expires_at <= ?`
  ).bind(token, now, cap).first();
  if (!row) return null;
  if (isIdleExpired(row.last_active_at, nowMs)) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return row;
}

export async function touchSession(env, token) {
  if (!token || !env.DB) return;
  await ensureSessionSchema(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE sessions SET last_active_at = ? WHERE token = ? AND expires_at > ?"
  ).bind(now, token, now).run();
}

export async function createSession(env, staffId, persist) {
  await ensureSessionSchema(env);
  const token = await randomToken();
  const maxAge = persist ? MAX_AGE : 12 * 60 * 60;
  const nowIso = new Date().toISOString();
  const expires = new Date(Date.now() + maxAge * 1000).toISOString();
  await env.DB.prepare("DELETE FROM sessions WHERE staff_id = ?").bind(staffId).run();
  await env.DB.prepare(
    "INSERT INTO sessions (token, staff_id, expires_at, last_active_at) VALUES (?, ?, ?, ?)"
  ).bind(token, staffId, expires, nowIso).run();
  return { token, cookie: sessionCookie(token, persist ? MAX_AGE : undefined) };
}

export function publicUser(row) {
  return {
    staff_id: row.staff_id,
    is_admin: Number(row.is_admin) === 1,
  };
}
