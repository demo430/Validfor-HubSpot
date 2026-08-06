// Takvim senkronu duman testi (network YOK): etkinlik normalizasyonu, VC
// domain sezgisi, aday cikarimi, endpoint auth.
process.env.FIREFLIES_WEBHOOK_SECRET = "test-secret";
process.env.NODE_ENV = "production"; // fail-closed yollarini da test et

import crypto from "node:crypto";
import {
  normalizeEvents,
  isVcDomain,
  extractVcCandidates,
  normalizePrivateKey,
} from "../lib/gcal.js";
import { app } from "../src/index.js";

let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

// isVcDomain — fon gibi gorunen domain'ler
check("vc domain: .vc TLD", isVcDomain("firstpoint.vc") === true);
check("vc domain: capital", isVcDomain("sequoiacapital.com") === true);
check("vc domain: cap kisaltmasi", isVcDomain("newcolumbiacap.com") === true);
check("vc domain: ventures", isVcDomain("acmeventures.io") === true);
check("vc domain: vc oneki", isVcDomain("vcfirm.com") === true);
check("vc domain: fund", isVcDomain("bigfund.com") === true);
check("vc domain: sirket degil fon degil", isVcDomain("amplelogic.com") === false);
check("vc domain: 'vc' icerir ama sinirda degil (avci)", isVcDomain("avci.com.tr") === false);
check("vc domain: bos", isVcDomain("") === false);

// normalizeEvents — iptal edilen atlanir, tarih/katilimci toparlanir
const now = Date.UTC(2026, 6, 22, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const events = normalizeEvents([
  {
    id: "e1", summary: "FirstPoint x Validfor Intro",
    start: { dateTime: iso(now + 2 * DAY) },
    organizer: { email: "Info@FirstPoint.vc" },
    attendees: [{ email: "demo@validfor.com" }, { email: "PARTNER@firstpoint.vc" }],
  },
  { id: "e2", summary: "iptal", status: "cancelled", start: { dateTime: iso(now + DAY) } },
  { id: "e3", summary: "tarihsiz" },
  {
    id: "e4", summary: "Acme demo",
    start: { dateTime: iso(now + 3 * DAY) },
    attendees: [{ email: "jane@acme.com" }],
  },
]);
check("normalize: iptal + tarihsiz atlanir", events.length === 2);
check("normalize: e-postalar kucuk harf + organizator dahil",
  events[0].attendees.includes("info@firstpoint.vc") &&
  events[0].attendees.includes("partner@firstpoint.vc"));

// Calendly kaynakli etkinlik VC adayi OLAMAZ (kural: Calendly = demo)
const calEvs = normalizeEvents([
  {
    id: "cl1", summary: "Demo w/ Fund",
    start: { dateTime: iso(now + 2 * DAY) },
    description: "Reschedule: https://calendly.com/reschedulings/xyz",
    attendees: [{ email: "brian@bigfund.com" }],
  },
]);
check("calendly imzasi yakalanir", calEvs[0].isCalendly === true);
check("calendly etkinligi VC adayi olmaz", extractVcCandidates(calEvs, now).length === 0);

// extractVcCandidates — ic domain atlanir, VC olmayan atlanir, en erken kazanir
const evs = normalizeEvents([
  {
    id: "a", summary: "Intro", start: { dateTime: iso(now + 5 * DAY) },
    attendees: [{ email: "brian@newcolumbiacap.com" }, { email: "demo@validfor.com" }],
  },
  {
    id: "b", summary: "Follow-up cagrisi", start: { dateTime: iso(now + 2 * DAY) },
    attendees: [{ email: "sean@newcolumbiacap.com" }],
  },
  {
    id: "c", summary: "gecmis", start: { dateTime: iso(now - DAY) },
    attendees: [{ email: "x@bigfund.com" }],
  },
  {
    id: "d", summary: "musteri", start: { dateTime: iso(now + DAY) },
    attendees: [{ email: "jane@acme.com" }, { email: "joe@gmail.com" }],
  },
]);
const cands = extractVcCandidates(evs, now);
const ncc = cands.find((c) => c.domain === "newcolumbiacap.com");
const bigfund = cands.find((c) => c.domain === "bigfund.com");
check("aday: VC domain'leri (gecmis dahil)", cands.length === 2 && !!ncc && !!bigfund);
check("aday: ayni fon icin en erken GELECEK etkinlik",
  ncc?.title === "Follow-up cagrisi" && ncc?.past === false);
check("aday: yalniz gecmis toplantisi olan fon past=true",
  bigfund?.past === true && bigfund?.title === "gecmis");
// gecmis + gelecek ayni fonda: gelecek kazanir
const mixed = extractVcCandidates(normalizeEvents([
  {
    id: "m1", summary: "eski gorusme", start: { dateTime: iso(now - 10 * DAY) },
    attendees: [{ email: "a@bigfund.com" }],
  },
  {
    id: "m2", summary: "yeni intro", start: { dateTime: iso(now + 3 * DAY) },
    attendees: [{ email: "a@bigfund.com" }],
  },
]), now);
check("aday: gecmis+gelecek varsa gelecek kazanir",
  mixed.length === 1 && mixed[0].past === false && mixed[0].title === "yeni intro");

// Yeni sinyaller: baslikta "intro" / VC kelimesi, katilimci adinda VC kelimesi
const sigEvs = normalizeEvents([
  {
    id: "s1", summary: "Validfor Intro (Edon)", start: { dateTime: iso(now + DAY) },
    attendees: [{ email: "edon@obscurellc.com" }], // domain fon gibi degil ama baslikta intro var
  },
  {
    id: "s2", summary: "Haftalik sync", start: { dateTime: iso(now + 2 * DAY) },
    attendees: [{ email: "mark@xyzpartners.com", displayName: "Mark (Blue Capital)" }],
  },
  {
    id: "s3", summary: "Musteri gorusmesi", start: { dateTime: iso(now + 3 * DAY) },
    attendees: [{ email: "jane@acme.com", displayName: "Jane Doe" }],
  },
]);
const sigCands = extractVcCandidates(sigEvs, now);
const sigDomains = sigCands.map((c) => c.domain).sort();
check("aday: baslikta 'intro' -> iceri", sigDomains.includes("obscurellc.com"));
check("aday: katilimci adinda VC kelimesi -> iceri", sigDomains.includes("xyzpartners.com"));
check("aday: sinyalsiz musteri -> disari", !sigDomains.includes("acme.com"));

// KESIN KURAL: adinda "demo" gecen etkinlik VC adayi olamaz — fon domain'i
// ya da "intro" sinyali olsa bile.
const demoEvs = normalizeEvents([
  {
    id: "d1", summary: "Amplelogics x Validfor Intro & Demo",
    start: { dateTime: iso(now + DAY) },
    attendees: [{ email: "rahul@bigfund.com" }],
  },
  {
    id: "d2", summary: "DEMO: fon tanitimi", start: { dateTime: iso(now + 2 * DAY) },
    attendees: [{ email: "x@sequoiacapital.com" }],
  },
]);
check("aday: adinda 'demo' gecen KESINLIKLE disari",
  extractVcCandidates(demoEvs, now).length === 0);

// Haric tutma listesi: mevcut yatirimci domain'i kosulsuz atlanir
// (bigfund'in gecmis adayi kalir — dislanan yalniz listedeki domain'dir)
const excluded = extractVcCandidates(evs, now, new Set(["newcolumbiacap.com"]));
check("aday: exclude listesi kosulsuz atlar",
  !excluded.some((c) => c.domain === "newcolumbiacap.com") && excluded.length === 1);

// normalizePrivateKey — bozuk yapistirma varyantlari gercek RSA anahtariyla
// dogrulanir: normalize edilen PEM'le imza atilabilmeli.
const { privateKey: pem } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const canSign = (k: string): boolean => {
  try {
    crypto.createSign("RSA-SHA256").update("x").sign(k);
    return true;
  } catch {
    return false;
  }
};
check("pem: temiz hali imzalar", canSign(normalizePrivateKey(pem)));
check("pem: tirnakli + \\n kacisli (Vercel yapistirmasi)",
  canSign(normalizePrivateKey('"' + pem.replace(/\n/g, "\\n") + '"')));
check("pem: govde tek satira yapismis",
  canSign(normalizePrivateKey(pem.replace(/\n(?!-----|$)/g, ""))));
check("pem: tum JSON dosyasi yapistirilmis",
  canSign(normalizePrivateKey(JSON.stringify({ type: "service_account", private_key: pem }))));

// Endpoint auth (Hono app.request — network yok)
const hint = await app.request("/api/calendar-sync");
const hintJson: any = await hint.json();
check("GET anahtarsiz -> 200 hint", hint.status === 200 && hintJson.hint !== undefined);
const bad = await app.request("/api/calendar-sync?key=WRONG");
check("yanlis key -> 401", bad.status === 401);
const noEnv = await app.request("/api/calendar-sync?key=test-secret&dry=1");
const noEnvJson: any = await noEnv.json();
check("dogru key, env'siz -> 200 + acik hata",
  noEnv.status === 200 && noEnvJson.ok === false &&
  /HUBSPOT_TOKEN|GOOGLE_CALENDAR/.test(noEnvJson.error || ""));

console.log(fail === 0 ? "\nOK: takvim senkronu duman testi gecti" : `\nHATA: ${fail} kontrol basarisiz`);
process.exit(fail === 0 ? 0 : 1);
