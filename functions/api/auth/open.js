import { json } from "../../_lib/auth.js";

export async function onRequestPost(context) {
  const sess = context.data && context.data.sess;
  if (!sess) return json({ error: "未登入" }, 401);
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    "INSERT INTO opens (staff_id, opened_at) VALUES (?, ?)"
  ).bind(sess.staff_id, now).run();
  return json({ ok: true });
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405, { Allow: "POST" });
  }
  return onRequestPost(context);
}
