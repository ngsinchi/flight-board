import {
  createSession,
  json,
  hashPassword,
  verifyPassword,
} from "../../_lib/auth.js";

export async function onRequestPost(context) {
  const sess = context.data && context.data.sess;
  if (!sess) return json({ error: "未登入" }, 401);
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "格式不正確" }, 400);
  }
  const oldPassword = typeof body.old_password === "string" ? body.old_password : "";
  const newPassword = typeof body.new_password === "string" ? body.new_password : "";
  if (!oldPassword || !newPassword) {
    return json({ error: "請輸入舊密碼同新密碼" }, 400);
  }
  if (newPassword.length < 4) {
    return json({ error: "新密碼至少要 4 個字" }, 400);
  }
  if (oldPassword === newPassword) {
    return json({ error: "新密碼唔可以同舊密碼一樣" }, 400);
  }
  const user = await context.env.DB.prepare(
    "SELECT staff_id, password_hash, is_admin FROM users WHERE staff_id = ?"
  ).bind(sess.staff_id).first();
  if (!user || !(await verifyPassword(oldPassword, user.password_hash))) {
    return json({ error: "舊密碼不正確" }, 401);
  }
  const hash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    "UPDATE users SET password_hash = ?, must_change = 0, updated_at = ? WHERE staff_id = ?"
  ).bind(hash, now, user.staff_id).run();
  await context.env.DB.prepare("DELETE FROM sessions WHERE staff_id = ?").bind(user.staff_id).run();
  const next = await createSession(context.env, user.staff_id, true);
  return json({ ok: true }, 200, { "Set-Cookie": next.cookie });
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405, { Allow: "POST" });
  }
  return onRequestPost(context);
}
