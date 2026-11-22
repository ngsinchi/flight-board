import { getSession, json } from "../_lib/auth.js";

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  if (
    path === "/api/auth/login" || path.endsWith("/auth/login") ||
    path === "/api/auth/logout" || path.endsWith("/auth/logout") ||
    path === "/api/excel" || path.endsWith("/api/excel") ||
    path === "/api/myorder" || path.endsWith("/api/myorder") ||
    path === "/api/done" || path.endsWith("/api/done") ||
    path === "/api/wa-lease" || path.endsWith("/api/wa-lease") ||
    path === "/api/ld-plan" || path.endsWith("/api/ld-plan")
  ) {
    return context.next();
  }
  const sess = await getSession(context.env, context.request);
  if (!sess) return json({ error: "未登入" }, 401);
  context.data = context.data || {};
  context.data.sess = sess;
  return context.next();
}
