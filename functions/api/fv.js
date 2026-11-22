export async function onRequest(context) {
  const incoming = new URL(context.request.url);
  const upstream = new URL("https://fv.menziescnac.com/data2");
  upstream.search = incoming.search;
  const headers = {
    Accept: context.request.headers.get("Accept") || "application/json",
    "User-Agent": context.request.headers.get("User-Agent") || "Mozilla/5.0",
  };
  const res = await fetch(upstream.toString(), { headers });
  const out = new Headers(res.headers);
  out.set("Cache-Control", "public, s-maxage=45, max-age=20");
  out.delete("Set-Cookie");
  return new Response(res.body, { status: res.status, headers: out });
}
