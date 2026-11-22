import { COOKIE, clearCookie, json, parseCookies } from "../../_lib/auth.js";
export async function onRequestPost(context) {
  const token = parseCookies(context.request)[COOKIE];
  if (token) {
    await context.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  }
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405, { Allow: "POST" });
  }
  return onRequestPost(context);
}
