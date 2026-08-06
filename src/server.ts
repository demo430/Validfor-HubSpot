import { serve } from "@hono/node-server";
import { loadEnv } from "../lib/env.js";
import { app } from "./index.js";

// .env.local'i yukle (yalnizca yerel; Vercel'de dosya yok, no-op). Yoksa dev
// sunucu API anahtarsiz + auth ACIK kosar ve istekler sessizce kaybolur.
loadEnv();

// Yerel gelistirme / self-host icin Node sunucu girisi. (Vercel'de bu dosya
// kullanilmaz; orada hono/vercel adaptoru devreye girer — Faz 6.)
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`validfor-relay dinliyor -> http://localhost:${info.port}`);
});
