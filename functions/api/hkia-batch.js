export async function onRequest(context) {
  const incoming = new URL(context.request.url);
  const dates = String(incoming.searchParams.get("dates") || "")
    .split(",")
    .map(s => s.trim())
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!dates.length) {
    return new Response(JSON.stringify({ error: "bad dates" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
  const headers = {
    Accept: "application/json",
    "User-Agent": context.request.headers.get("User-Agent") || "Mozilla/5.0",
    Referer: "https://www.hongkongairport.com/en/flights/arrivals/passenger.page"
  };
  const jobs = [];
  for (const date of dates) {
    for (const arrival of [true, false]) {
      for (const cargo of [false, true]) {
        jobs.push(fetchHkia(date, arrival, cargo, headers));
      }
    }
  }
  const settled = await Promise.all(jobs);
  const items = settled.filter(Boolean);
  if (!items.length) {
    return new Response(JSON.stringify({ error: "hkia failed", items: [] }), {
      status: 502,
      headers: { "Content-Type": "application/json" }
    });
  }
  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=20, max-age=10"
    }
  });
}

async function fetchHkia(date, arrival, cargo, headers) {
  const upstream = new URL("https://www.hongkongairport.com/flightinfo-rest/rest/flights");
  upstream.searchParams.set("date", date);
  upstream.searchParams.set("arrival", arrival ? "true" : "false");
  upstream.searchParams.set("cargo", cargo ? "true" : "false");
  upstream.searchParams.set("lang", "en");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(upstream.toString(), { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    const blocks = await res.json();
    return { date, arrival, cargo, blocks };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}
