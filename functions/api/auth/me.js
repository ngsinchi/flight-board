import { json, publicUser, touchSession } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const sess = context.data && context.data.sess;
  if (!sess) return json({ error: "未登入" }, 401);
  await touchSession(context.env, sess.token);
  return json({ ok: true, user: publicUser(sess) });
}

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return json({ error: "Method Not Allowed" }, 405, { Allow: "GET" });
  }
  return onRequestGet(context);
}
