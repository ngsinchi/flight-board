import { json } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const sess = context.data && context.data.sess;
  if (!sess) return json({ error: "未登入" }, 401);
  if (Number(sess.is_admin) !== 1 || sess.staff_id !== "1000741") {
    return json({ error: "沒有權限" }, 403);
  }
  const users = await context.env.DB.prepare(
    `SELECT u.staff_id,
            COALESCE(c.opens, 0) AS opens,
            c.last_opened_at
     FROM users u
     LEFT JOIN (
       SELECT staff_id, COUNT(*) AS opens, MAX(opened_at) AS last_opened_at
       FROM opens
       GROUP BY staff_id
     ) c ON c.staff_id = u.staff_id
     ORDER BY c.last_opened_at IS NULL, c.last_opened_at DESC, u.staff_id ASC`
  ).all();
  return json({ ok: true, rows: (users && users.results) || [] });
}

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return json({ error: "Method Not Allowed" }, 405, { Allow: "GET" });
  }
  return onRequestGet(context);
}
