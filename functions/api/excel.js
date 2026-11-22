import { buildTimesCsv, feedYmd } from "../_lib/flight-times.js";

function unauthorized() {
  return new Response("Unauthorized\n", {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function csvResponse(csv, extra = {}) {
  const headers = {
    "Content-Type": "text/csv; charset=utf-8",
    "Cache-Control": "public, max-age=30, s-maxage=30",
    "Access-Control-Allow-Origin": "*",
    ...extra
  };
  return new Response(csv, { status: 200, headers });
}

async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS excel_feed (
      ymd TEXT PRIMARY KEY,
      csv TEXT NOT NULL,
      built_at INTEGER NOT NULL
    )`
  ).run();
}

async function loadFeed(db, ymd) {
  try {
    return await db.prepare("SELECT csv, built_at FROM excel_feed WHERE ymd = ?").bind(ymd).first();
  } catch {
    await ensureSchema(db);
    return await db.prepare("SELECT csv, built_at FROM excel_feed WHERE ymd = ?").bind(ymd).first();
  }
}

async function saveFeed(db, ymd, csv) {
  await ensureSchema(db);
  await db.prepare(
    "INSERT INTO excel_feed (ymd, csv, built_at) VALUES (?, ?, ?) ON CONFLICT(ymd) DO UPDATE SET csv = excluded.csv, built_at = excluded.built_at"
  ).bind(ymd, csv, Date.now()).run();
}

async function refresh(db, ymd, prevCsv) {
  const csv = await buildTimesCsv(prevCsv || "");
  await saveFeed(db, ymd, csv);
  return csv;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return new Response("Method Not Allowed\n", { status: 405 });
  }
  const key = url.searchParams.get("key") || "";
  const expected = context.env.EXCEL_FEED_KEY || "";
  if (!expected || key !== expected) return unauthorized();

  const db = context.env.DB;
  const ymd = feedYmd(0);
  const force = url.searchParams.get("refresh") === "1";
  const existing = db ? await loadFeed(db, ymd) : null;
  const staleMs = 2 * 60 * 1000;
  const stale = !existing || (Date.now() - Number(existing.built_at || 0) > staleMs);

  if (existing && existing.csv && !force) {
    if (stale && context.waitUntil && db) {
      context.waitUntil(refresh(db, ymd, existing.csv).catch(() => {}));
    }
    return csvResponse(existing.csv, { "X-Excel-Cache": stale ? "stale" : "fresh" });
  }

  if (!db) {
    const csv = await buildTimesCsv("");
    return csvResponse(csv, { "X-Excel-Cache": "miss" });
  }

  const csv = await refresh(db, ymd, (existing && existing.csv) || "");
  return csvResponse(csv, { "X-Excel-Cache": "built" });
}
