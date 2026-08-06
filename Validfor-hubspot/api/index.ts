import type { ServerResponse } from "node:http";
import app from "../src/index.js";

// Vercel Node (req,res) serverless fonksiyonu.
//
// Neden elle koprulendi: @vercel/node gelen istegin govdesini ONCEDEN parse
// edip req.body'ye koyar ve alttaki stream'i TUKETIR. Bu yuzden stream okuyan
// bridge'ler (hono/vercel handle, @hono/node-server getRequestListener) POST'ta
// sonsuza kadar bekleyip 504 FUNCTION_INVOCATION_TIMEOUT veriyordu. Burada Web
// Request'i Vercel'in verdigi req.body'den kuruyoruz; req.body yoksa (yerel)
// stream'i okuyoruz -> hem Vercel'de hem yerelde calisir.
export const config = { maxDuration: 60 };

async function readBody(req: any): Promise<string | undefined> {
  // req.body @vercel/node'da LAZY getter'dir ve bozuk JSON'da ERISIM ANINDA
  // firlatir (ApiError 400). Yakalamazsak bridge 500 doner ve "her zaman 200"
  // (anti-retry-firtinasi) tasarimi bozulur -> bozuk govdeyi bos say.
  let parsed: unknown;
  try {
    parsed = req.body;
  } catch {
    return undefined; // Hono tarafinda bad_json -> 200
  }
  if (parsed != null) {
    if (typeof parsed === "string") return parsed;
    if (Buffer.isBuffer(parsed)) return parsed.toString("utf8");
    return JSON.stringify(parsed); // Vercel parse etmis obje
  }
  // Yerel / parse edilmemis govde: 'data'/'end' event'leriyle oku. (Async
  // iterator DEGIL: @vercel/node stream'i tuketip restoreBody ile yalnizca
  // read()/'data' arayuzlerini yamalar; async iterator bos doner.)
  return new Promise<string | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => resolve(undefined), 5000); // guvenlik agi
    req.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      clearTimeout(timer);
      resolve(chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined);
    });
    req.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export default async function handler(
  req: any,
  res: ServerResponse,
): Promise<void> {
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const url = `${proto}://${host}${req.url || "/"}`;
    const method = (req.method || "GET").toUpperCase();

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, String(x)));
      else headers.set(k, String(v));
    }

    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await readBody(req) : undefined;

    const request = new Request(url, { method, headers, body });
    const response = await app.fetch(request);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e: any) {
    // Detay yalniz loga — ic hata metni istemciye sizmasin.
    console.error("[bridge] islenemeyen hata:", e?.message || e);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "internal_error" }));
  }
}
