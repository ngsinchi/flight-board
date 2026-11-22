export async function onRequest(context) {
  const incoming = new URL(context.request.url);
  const upstream = new URL("https://www.hongkongairport.com/flightinfo-rest/rest/flights");
  upstream.search = incoming.search;
  const headers = {
    Accept: context.request.headers.get("Accept") || "application/json",
    "User-Agent": context.request.headers.get("User-Agent") || "Mozilla/5.0",
    Referer: "https://www.hongkongairport.com/en/flights/arrivals/passenger.page",
  };
  const res = await fetch(upstream.toString(), { headers });
  const out = new Headers(res.headers);
  out.set("Cache-Control", "public, s-maxage=20, max-age=10");
  out.delete("Set-Cookie");
  return new Response(res.body, { status: res.status, headers: out });
}
