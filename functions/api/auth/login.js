import {
  createSession,
  json,
  normalizeStaffId,
  publicUser,
  verifyPassword,
} from "../../_lib/auth.js";

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "格式不正確" }, 400);
  }
  const staffId = normalizeStaffId(body.staff_id || body.login);
  const password = typeof body.password === "string" ? body.password : "";
  if (!staffId || !password) {
    return json({ error: "請輸入職員編號同密碼" }, 400);
  }
  const persist = body.stay !== false && body.persist !== false;
  const user = await context.env.DB.prepare(
    "SELECT staff_id, password_hash, is_admin FROM users WHERE staff_id = ?"
  ).bind(staffId).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: "職員編號或密碼不正確" }, 401);
  }
  const sess = await createSession(context.env, user.staff_id, persist);
  return json({ ok: true, user: publicUser(user) }, 200, { "Set-Cookie": sess.cookie });
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405, { Allow: "POST" });
  }
  return onRequestPost(context);
}
