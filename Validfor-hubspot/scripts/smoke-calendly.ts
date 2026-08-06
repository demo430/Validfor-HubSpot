// Calendly senkronu duman testi (network YOK): normalizasyon, demo aday
// cikarimi, endpoint auth.
process.env.FIREFLIES_WEBHOOK_SECRET = "test-secret";
process.env.NODE_ENV = "production"; // fail-closed yollarini da test et

import { normalizeCalendlyEvents, extractDemoCandidates } from "../lib/calendly.js";
import { app } from "../src/index.js";

let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

const now = Date.UTC(2026, 6, 22, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

// normalizeCalendlyEvents — iptal/tarihsiz atlanir, uuid uri'den cikar
const evs = normalizeCalendlyEvents([
  {
    uri: "https://api.calendly.com/scheduled_events/ABC-123",
    name: "Validfor Demo",
    status: "active",
    start_time: iso(now + 2 * DAY),
  },
  { uri: "https://api.calendly.com/scheduled_events/X", name: "iptal", status: "canceled", start_time: iso(now + DAY) },
  { uri: "https://api.calendly.com/scheduled_events/Y", name: "tarihsiz" },
]);
check("normalize: iptal + tarihsiz atlanir", evs.length === 1);
check("normalize: uuid uri'den", evs[0].id === "ABC-123" && evs[0].title === "Validfor Demo");

// extractDemoCandidates — ic/serbest e-posta atlanir, en erken kazanir, gecmis atlanir
const cands = extractDemoCandidates(
  [
    { title: "Demo A", startMs: now + 5 * DAY, emails: ["rahul@amplelogic.com", "demo@validfor.com"] },
    { title: "Demo B", startMs: now + 2 * DAY, emails: ["priya@amplelogic.com"] },
    { title: "Kisisel", startMs: now + DAY, emails: ["joe@gmail.com"] },
    { title: "Gecmis", startMs: now - DAY, emails: ["x@acme.com"] },
  ],
  now,
);
check("aday: sirket domain'i + en erken rezervasyon",
  cands.length === 1 && cands[0].domain === "amplelogic.com" && cands[0].title === "Demo B");

// Endpoint auth (Hono app.request — network yok)
const hint = await app.request("/api/calendly-sync");
const hintJson: any = await hint.json();
check("GET anahtarsiz -> 200 hint", hint.status === 200 && hintJson.hint !== undefined);
const bad = await app.request("/api/calendly-sync?key=WRONG");
check("yanlis key -> 401", bad.status === 401);
const noEnv = await app.request("/api/calendly-sync?key=test-secret&dry=1");
const noEnvJson: any = await noEnv.json();
check("dogru key, token'siz -> 200 + acik hata",
  noEnv.status === 200 && noEnvJson.ok === false &&
  /HUBSPOT_TOKEN|CALENDLY_TOKEN/.test(noEnvJson.error || ""));

console.log(fail === 0 ? "\nOK: Calendly senkron duman testi gecti" : `\nHATA: ${fail} kontrol basarisiz`);
process.exit(fail === 0 ? 0 : 1);
