// Google Calendar -> HubSpot VC Pipeline: planlanmis yatirimci toplantilari
// toplanti OLMADAN once deal olarak acilir (giris stage'i: VC pipeline'da
// "Scheduled" etiketli stage varsa o, yoksa "Contacted" — canli cozulur).
// Toplanti gerceklesince Fireflies akisi ayni deal'i bulur (domain-ad
// fallback'i upsert'te) ve stage otomasyonu Meeting'e tasir.
//
// Kimlik dogrulama (iki yol, oncelik sirasiyla):
//   1. SERVICE ACCOUNT (onerilen — takvim OZEL kalir): GOOGLE_SA_EMAIL +
//      GOOGLE_SA_PRIVATE_KEY env'leri; takvim service account e-postasiyla
//      "Tum etkinlik ayrintilarini gorme" izniyle PAYLASILMIS olmali.
//      JWT RS256 ile imzalanip oauth2.googleapis.com/token'dan erisim
//      token'i alinir (ek paket yok — node:crypto).
//   2. API KEY (yalnizca HERKESE ACIK takvim okur): GOOGLE_CALENDAR_API_KEY.
// Her iki yolda da GOOGLE_CALENDAR_ID gerekli.
import crypto from "node:crypto";
import * as hs from "./hubspot.js";
import { normKey } from "./vcfields.js";
import { desiredCompanyProps } from "./company.js";
import { enrichOrganization } from "./apollo.js";
import {
  emailDomain,
  isInternalEmail,
  FREE_EMAIL_DOMAINS,
  isCompanyDomain,
  sameCompanyName,
  VC_PIPELINE_ID,
  VC_STAGE,
  PIPELINE_ID,
  STAGE,
} from "./upsert.js";

export interface CalendarEvent {
  id: string;
  title: string;
  startMs: number;
  /** Katilimci e-postalari (organizator dahil), kucuk harf. */
  attendees: string[];
  /** Katilimci gorunen adlari (varsa) — "Mark (Blue Capital)" gibi ipuclari tasir. */
  names: string[];
  /** Calendly'den takvime dusen etkinlik — kural geregi DEMO'dur, VC adayi olamaz. */
  isCalendly: boolean;
  /**
   * Calendly rezervasyon formundaki "Company Name" cevabi. Calendly bu cevaplari
   * aktardigi takvim etkinliginin ACIKLAMASINA yazar; Calendly API'sine gerek yok.
   * Serbest webmail'li (gmail/icloud) davetlilerde sirketi bilmenin tek yolu budur.
   */
  companyName: string;
}

// Etkinlik aciklamasindan "Company Name: X" satirini cikarir (SAF).
// Calendly formatı: "Job Title: ...\n\nCompany Name: CHG\n\n..."
export function extractCompanyNameFromDescription(desc: string): string {
  const m = /company\s*name\s*:\s*([^\r\n]+)/i.exec(String(desc || ""));
  if (!m) return "";
  // Bazi hesaplarda cevap HTML olarak gelir; etiketleri ayikla.
  return m[1].replace(/<[^>]*>/g, "").trim().slice(0, 120);
}

// Google events yanitini normalize eder (SAF).
export function normalizeEvents(items: any[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const it of items || []) {
    if (!it || it.status === "cancelled") continue;
    const start = it.start?.dateTime || it.start?.date;
    const startMs = start ? new Date(String(start)).getTime() : NaN;
    if (isNaN(startMs)) continue;
    const emails = new Set<string>();
    const names = new Set<string>();
    for (const a of it.attendees || []) {
      const e = String(a?.email || "").toLowerCase().trim();
      if (e.includes("@")) emails.add(e);
      const n = String(a?.displayName || "").trim();
      if (n) names.add(n);
    }
    const org = String(it.organizer?.email || "").toLowerCase().trim();
    if (org.includes("@")) emails.add(org);
    const orgName = String(it.organizer?.displayName || "").trim();
    if (orgName) names.add(orgName);
    // Calendly, aktardigi etkinliklerin iCalUID/aciklama/konumuna imzasini birakir.
    const hay = `${it.iCalUID || ""} ${it.description || ""} ${it.location || ""}`.toLowerCase();
    out.push({
      id: String(it.id || ""),
      title: String(it.summary || "").trim(),
      startMs,
      attendees: [...emails],
      names: [...names],
      isCalendly: hay.includes("calendly"),
      companyName: extractCompanyNameFromDescription(String(it.description || "")),
    });
  }
  return out;
}

// VC/fon domain sezgisi (SAF). Bilincli muhafazakar-genis: yanlis pozitif deal
// "Contacted/Scheduled"da elle silinebilir; kacirilan fon hic gorunmez.
export function isVcDomain(domain: string): boolean {
  const d = String(domain || "").toLowerCase().trim();
  if (!d) return false;
  if (d.endsWith(".vc")) return true; // firstpoint.vc gibi fon TLD'si
  const host = d.split(".")[0];
  if (host.startsWith("vc") || host.endsWith("vc")) return true;
  if (host.endsWith("cap")) return true; // "newcolumbiacap" gibi kisaltmalar
  return /capital|venture|fund|angel|equity|invest|holding/.test(d);
}

export interface VcCandidate {
  domain: string;
  title: string;
  startMs: number;
  /** true: yalniz GECMIS toplantisi var — deal dogrudan "Meeting"de acilir. */
  past: boolean;
}

// VC sinyal kelimeleri — etkinlik ADINDA ya da katilimci GORUNEN ADLARINDA
// aranir (kullanici kurali).
export const VC_KEYWORDS = /capital|venture|fund|angel|equity/;

// VC_EXCLUDE_DOMAINS env'i: mevcut yatirimcilar / portfoy sirketleri gibi
// toplantisi olsa da ASLA otomatik VC deal'i acilmayacak domain'ler
// (virgul ayracli, or. "curiosityvc.com,weplayventures.com").
export function vcExcludeDomains(): Set<string> {
  return new Set(
    String(process.env.VC_EXCLUDE_DOMAINS || "")
      .split(",")
      .map((s) => s.replace(/['"]+/g, "").trim().toLowerCase()) // tirnakli yapistirma tolere
      .filter(Boolean),
  );
}

// Etkinliklerden VC adaylarini cikarir (SAF). Bir etkinligin harici katilimci
// sirketi su sinyallerden BIRIYLE iceri alinir:
//   - etkinlik adinda "intro" geciyor
//   - etkinlik adinda VC kelimesi geciyor (capital/venture/fund/angel/equity)
//   - katilimci gorunen adlarinda VC kelimesi geciyor
//   - domain'in kendisi fon gibi gorunuyor (isVcDomain — yedek sinyal)
// exclude listesindeki domain'ler kosulsuz atlanir. Fon basina tek aday:
// GELECEK toplantisi varsa en erken gelecek (past=false); yalniz GECMIS
// toplantisi varsa en yeni gecmis (past=true — Fireflies kacirmissa deal
// dogrudan Meeting'de acilsin).
export function extractVcCandidates(
  events: CalendarEvent[],
  nowMs: number,
  exclude: Set<string> = new Set(),
): VcCandidate[] {
  const byDomain = new Map<string, VcCandidate>();
  for (const ev of events) {
    if (ev.isCalendly) continue; // Calendly = DEMO (Sales isi; calendly.ts halleder)
    const title = ev.title.toLowerCase();
    // KESIN KURAL: adinda "demo" gecen etkinlik VC adayi OLAMAZ — "X Intro &
    // Demo" gibi musteri tanismalari "intro" sinyaliyle iceri sizmisti.
    if (title.includes("demo")) continue;
    const titleHit = title.includes("intro") || VC_KEYWORDS.test(title);
    const nameHit = ev.names.some((n) => VC_KEYWORDS.test(n.toLowerCase()));
    const isPast = ev.startMs <= nowMs;
    for (const email of ev.attendees) {
      if (isInternalEmail(email)) continue;
      const domain = emailDomain(email);
      if (!isCompanyDomain(domain)) continue;
      if (exclude.has(domain)) continue;
      if (!titleHit && !nameHit && !isVcDomain(domain)) continue;
      const cur = byDomain.get(domain);
      const cand: VcCandidate = { domain, title: ev.title, startMs: ev.startMs, past: isPast };
      if (!cur) {
        byDomain.set(domain, cand);
      } else if (!cur.past) {
        // elimizde gelecek toplanti var: yalniz daha erken bir GELECEK yener
        if (!isPast && ev.startMs < cur.startMs) byDomain.set(domain, cand);
      } else {
        // elimizde gecmis var: gelecek her zaman yener; gecmislerde en yeni kalir
        if (!isPast || ev.startMs > cur.startMs) byDomain.set(domain, cand);
      }
    }
  }
  return [...byDomain.values()];
}

const b64url = (input: string | Buffer): string =>
  (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// PEM'i kopyalama/yapistirma varyantlarina dayanikli normalize eder (SAF):
// - deger tum JSON dosyasiysa icindeki private_key cekilir
// - bastaki/sondaki tirnaklar atilir ("private_key" degeri tirnagiyla kopyalanmis)
// - "\n" / "\r" kacislari gercek satir sonuna cevrilir
// - govde tek satira yapismissa 64'luk satirlara yeniden sarilir
// Aksi halde Node OpenSSL "DECODER routines::unsupported" ile reddeder.
export function normalizePrivateKey(raw: string): string {
  let k = String(raw || "").trim();
  if (k.startsWith("{")) {
    try {
      k = String(JSON.parse(k)?.private_key || k);
    } catch {
      /* JSON degilmis — oldugu gibi devam */
    }
  }
  k = k.replace(/^['"]+/, "").replace(/['"]+$/, "");
  k = k.replace(/\\r/g, "").replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(k);
  if (m) {
    const body = m[2].replace(/\s+/g, "");
    const wrapped = body.replace(/(.{64})/g, "$1\n").trim();
    k = `-----BEGIN ${m[1]}-----\n${wrapped}\n-----END ${m[1]}-----\n`;
  }
  return k;
}

// Service account erisim token'i (~1 saat gecerli; process icinde onbellekli).
let saTokenCache: { token: string; expMs: number } | null = null;
async function serviceAccountToken(email: string, privateKeyRaw: string): Promise<string> {
  if (saTokenCache && Date.now() < saTokenCache.expMs) return saTokenCache.token;
  const privateKey = normalizePrivateKey(privateKeyRaw);
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
    "." +
    b64url(
      JSON.stringify({
        iss: email,
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
  let signature: Buffer;
  try {
    signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  } catch (e: any) {
    // Ham OpenSSL hatasi ("DECODER routines::unsupported") yol gostermiyor —
    // kullaniciya ne yapacagini soyle.
    throw new Error(
      "GOOGLE_SA_PRIVATE_KEY okunamadi (PEM bozuk): JSON dosyasindaki private_key " +
        "degerini -----BEGIN/END PRIVATE KEY----- satirlari DAHIL, tirnaklar OLMADAN " +
        `yapistir (kacisli \\n'ler sorun degil). Detay: ${String(e?.message || e).slice(0, 80)}`,
    );
  }
  const jwt = `${unsigned}.${b64url(signature)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=" +
      encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      `&assertion=${jwt}`,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google token alinamadi (${res.status}): ${text.slice(0, 200)}`);
  }
  const token = String(JSON.parse(text)?.access_token || "");
  if (!token) throw new Error("Google token yaniti bos");
  saTokenCache = { token, expMs: Date.now() + 50 * 60_000 };
  return token;
}

// GOOGLE_CALENDAR_ID virgul ayracli COKLU takvim kabul eder (VC toplantilari
// birden fazla takvime dagilmis olabilir). Her takvim service account'la
// paylasilmis olmali.
export function calendarIds(): string[] {
  return String(process.env.GOOGLE_CALENDAR_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fetchUpcomingEvents(
  calId: string,
  days: number,
  pastDays: number,
  untilDays = 0, // >0: pencere TAMAMEN gecmiste biter (now - untilDays) — batch tarama
): Promise<CalendarEvent[]> {
  const saEmail = process.env.GOOGLE_SA_EMAIL;
  const saKey = process.env.GOOGLE_SA_PRIVATE_KEY;
  const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
  if (!(saEmail && saKey) && !apiKey) {
    throw new Error(
      "GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY (onerilen) ya da GOOGLE_CALENDAR_API_KEY gerekli",
    );
  }
  const useSa = Boolean(saEmail && saKey);
  const now = Date.now();
  const min = new Date(now - pastDays * 86_400_000);
  // Buyuk geriye donuk taramalar 60 sn fonksiyon sinirina ve takvim basina 250
  // etkinlik sayfasina sigmaz; ?until ile [past, until] gun dilimlerine bolunur.
  const max =
    untilDays > 0 ? new Date(now - untilDays * 86_400_000) : new Date(now + days * 86_400_000);
  let url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events` +
    `?timeMin=${min.toISOString()}&timeMax=${max.toISOString()}` +
    `&singleEvents=true&orderBy=startTime&maxResults=250`;
  const headers: Record<string, string> = {};
  if (useSa) {
    headers.Authorization = `Bearer ${await serviceAccountToken(saEmail!, saKey!)}`;
  } else {
    url += `&key=${encodeURIComponent(apiKey!)}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        useSa
          ? "Google takvim bulunamadi: takvimi service account e-postasiyla paylastigindan " +
            "('Tum etkinlik ayrintilarini gorme' izniyle) ve GOOGLE_CALENDAR_ID'den emin ol."
          : "Google takvim bulunamadi ya da HERKESE ACIK degil (API key yalniz public " +
            "takvim okur). Onerilen: service account kur ve takvimi onunla paylas. " +
            "GOOGLE_CALENDAR_ID'yi de kontrol et.",
      );
    }
    throw new Error(`Google Calendar ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  return normalizeEvents(json?.items || []);
}

// VC giris stage'i canli cozulur: "Scheduled" etiketli stage eklenirse otomatik
// o kullanilir; yoksa "Contacted"; o da yoksa koddaki sabit.
let entryStageCache: Promise<string> | null = null;
function resolveVcEntryStage(): Promise<string> {
  if (!entryStageCache) {
    entryStageCache = hs
      .hsFetch<any>(`/crm/v3/pipelines/deals/${VC_PIPELINE_ID}`)
      .then((p) => {
        const stages: any[] = Array.isArray(p?.stages) ? p.stages : [];
        const byLabel = (want: string): string =>
          String(stages.find((s) => normKey(String(s?.label || "")) === want)?.id || "");
        return byLabel("scheduled") || byLabel("contacted") || VC_STAGE.contacted;
      })
      .catch((e) => {
        entryStageCache = null;
        throw e;
      });
  }
  return entryStageCache;
}

export interface CalendarSyncResult {
  events: number; //       okunan gelecek etkinlik
  candidates: number; //   VC gibi gorunen fon domain'i
  created: number; //      acilan deal (dry'da: acilacak)
  existing: number; //     zaten deal'i var -> dokunulmadi
  errors: number;
  /** Aktif haric tutma listesi (VC_EXCLUDE_DOMAINS) — env'in canlida yuklu
   * oldugu yanittan dogrulanabilsin diye raporlanir. */
  excluded: string[];
  items: string[];
}

// Bir sirketin verilen pipeline'da zaten deal'i var mi? Once domain-adli deal
// (hangi pipeline'da olursa olsun), sonra domain'in sirketine bagli deal'lar
// (Fireflies'in actigi GUZEL adli deal'lar boyle yakalanir -> mukerrer
// "scheduled" deal acilmaz). gcal (VC) ve calendly (Sales) ortak kullanir.
export async function findExistingDealForDomain(
  domain: string,
  pipelineId: string,
): Promise<boolean> {
  const byName = await hs.searchDealsByName(domain);
  if (byName) return true;
  const comp = await hs.searchByProperty("company", "domain", "EQ", domain, ["name"]);
  if (!comp) return false;
  const dealIds = (await hs.getAssociations("company", comp.id, "deal")).slice(0, 20);
  for (const id of dealIds) {
    const d = await hs.getObject("deal", id, ["pipeline"]);
    if (String(d?.properties?.pipeline || "") === pipelineId) return true;
  }
  return false;
}

export async function syncScheduledVcDeals(
  opts: {
    days?: number;
    pastDays?: number;
    /** >0: pencere (now-pastDays, now-untilDays) — genis taramayi dilimlere boler. */
    untilDays?: number;
    /** Tek seferlik ek dislama (env VC_EXCLUDE_DOMAINS ile birlesir). */
    extraExclude?: string[];
    dry?: boolean;
  } = {},
): Promise<CalendarSyncResult> {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  const days = opts.days ?? 30;
  // Geriye donuk guvenlik agi (varsayilan 7 gun): Fireflies'in kacirdigi /
  // kaydetmedigi gecmis VC toplantilari da deal olsun (dogrudan "Meeting"de).
  // Tek seferlik genis tarama icin route ?past=90 gibi buyutulebilir.
  const pastDays = opts.pastDays ?? 7;
  const untilDays = Math.max(0, opts.untilDays ?? 0);
  if (untilDays > 0 && untilDays >= pastDays) {
    throw new Error(`untilDays (${untilDays}) pastDays'ten (${pastDays}) kucuk olmali`);
  }
  const dry = !!opts.dry;
  const ids = calendarIds();
  if (!ids.length) throw new Error("GOOGLE_CALENDAR_ID tanimli degil");

  // Takvimler tek tek okunur: biri bozuksa (paylasilmamis/yanlis ID) digerleri
  // yine islenir; bozuk olan items'da HATA satiri olarak gorunur. Ayni etkinlik
  // birden fazla takvimde olabilir — aday cikarimi domain bazinda tekillestirir.
  const events: CalendarEvent[] = [];
  const calErrors: string[] = [];
  for (const id of ids) {
    try {
      events.push(...(await fetchUpcomingEvents(id, days, pastDays, untilDays)));
    } catch (e: any) {
      calErrors.push(`${id}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  if (!events.length && calErrors.length) {
    throw new Error(`hicbir takvim okunamadi — ${calErrors.join(" | ")}`.slice(0, 500));
  }

  const exclude = vcExcludeDomains();
  for (const d of opts.extraExclude || []) {
    const clean = d.trim().toLowerCase();
    if (clean) exclude.add(clean);
  }
  const candidates = extractVcCandidates(events, Date.now(), exclude);
  const r: CalendarSyncResult = {
    events: events.length,
    candidates: candidates.length,
    created: 0,
    existing: 0,
    errors: calErrors.length,
    excluded: [...exclude],
    items: [],
  };
  const note = (line: string): void => {
    if (r.items.length < 100) r.items.push(line);
  };
  for (const err of calErrors) note(`HATA takvim ${err}`);
  if (!candidates.length) return r;

  const entryStage = await resolveVcEntryStage();
  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
  for (const cand of candidates) {
    // HubSpot ARAMA API'si ayrica sinirli (4 istek/sn): aday basina 2+ arama
    // yapiyoruz; frensiz dongude 429 "secondly limit" yagiyordu.
    await sleep(350);
    try {
      if (await findExistingDealForDomain(cand.domain, VC_PIPELINE_ID)) {
        r.existing++;
        continue;
      }
      const when = new Date(cand.startMs).toISOString().slice(0, 16).replace("T", " ");
      // Gecmis toplanti = gerceklesmis -> dogrudan "Meeting"; gelecek -> giris stage'i.
      const stage = cand.past ? VC_STAGE.meeting : entryStage;
      if (!dry) {
        // Sirket bul-olustur + deal DOMAIN adiyla acilir; toplanti gerceklesince
        // Fireflies akisi gercek fon adini ogrenip dealname'i gunceller.
        let companyId = "";
        const comp = await hs.searchByProperty("company", "domain", "EQ", cand.domain, ["name"]);
        companyId = comp?.id || "";
        if (!companyId) {
          const created = await hs.createObject("company", {
            name: cand.domain,
            domain: cand.domain,
          });
          companyId = String(created.id);
        }
        const deal = await hs.createObject("deal", {
          dealname: cand.domain,
          pipeline: VC_PIPELINE_ID,
          dealstage: stage,
        });
        if (companyId) await hs.associateDefault("deal", String(deal.id), "company", companyId);
      }
      r.created++;
      note(
        `${cand.domain}: "${cand.title || "(bassiz etkinlik)"}" @ ${when} UTC -> ` +
          `VC deal acildi${cand.past ? " (gecmis toplanti -> Meeting)" : ""}`,
      );
    } catch (e: any) {
      r.errors++;
      note(`HATA ${cand.domain}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  return r;
}

// ============================ TUM SIRKETLER =============================
export interface CalendarCompaniesResult {
  events: number; //   okunan etkinlik
  domains: number; //  benzersiz harici domain
  created: number; //  acilan sirket (dry'da: acilacak)
  existing: number; // zaten vardi -> dokunulmadi
  errors: number;
  /** false: zaman butcesine takildi — AYNI cagriyi tekrar et (idempotent). */
  done: boolean;
  items: string[];
}

// Takvimdeki TUM harici katilimci sirketlerini HubSpot'a company olarak acar
// (VC filtresi YOK — musteri/partner/danisman herkes dahil). Domain ile
// bul-ya-da-olustur; var olan sirkete DOKUNULMAZ. Yeni sirketin adi ve temel
// alanlari mumkunse Apollo organizations/enrich'ten gelir: sirket YENI oldugu
// icin ad yazmak "sirket adina dokunulmaz" kuralini ihlal etmez (o kural
// insanin girdigi degeri korur; burada henuz deger yok).
export async function syncCalendarCompanies(
  opts: {
    days?: number;
    pastDays?: number;
    untilDays?: number;
    dry?: boolean;
    budgetMs?: number;
  } = {},
): Promise<CalendarCompaniesResult> {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  const days = opts.days ?? 1;
  const pastDays = opts.pastDays ?? 30;
  const untilDays = Math.max(0, opts.untilDays ?? 0);
  if (untilDays > 0 && untilDays >= pastDays) {
    throw new Error(`untilDays (${untilDays}) pastDays'ten (${pastDays}) kucuk olmali`);
  }
  const dry = !!opts.dry;
  const budgetMs = opts.budgetMs ?? 45_000;
  const t0 = Date.now();
  const ids = calendarIds();
  if (!ids.length) throw new Error("GOOGLE_CALENDAR_ID tanimli degil");

  const events: CalendarEvent[] = [];
  const calErrors: string[] = [];
  for (const id of ids) {
    try {
      events.push(...(await fetchUpcomingEvents(id, days, pastDays, untilDays)));
    } catch (e: any) {
      calErrors.push(`${id}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  if (!events.length && calErrors.length) {
    throw new Error(`hicbir takvim okunamadi — ${calErrors.join(" | ")}`.slice(0, 500));
  }

  const domains = new Set<string>();
  for (const ev of events) {
    for (const email of ev.attendees) {
      if (isInternalEmail(email)) continue;
      const d = emailDomain(email);
      if (isCompanyDomain(d)) domains.add(d);
    }
  }

  const r: CalendarCompaniesResult = {
    events: events.length,
    domains: domains.size,
    created: 0,
    existing: 0,
    errors: calErrors.length,
    done: false,
    items: [],
  };
  const note = (line: string): void => {
    if (r.items.length < 100) r.items.push(line);
  };
  for (const err of calErrors) note(`HATA takvim ${err}`);

  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
  for (const domain of [...domains].sort()) {
    if (Date.now() - t0 > budgetMs) return r; // done=false — ayni cagriyi tekrarla
    await sleep(250); // HubSpot arama limiti (4/sn) freni
    try {
      const comp = await hs.searchByProperty("company", "domain", "EQ", domain, ["name"]);
      if (comp) {
        r.existing++;
        continue;
      }
      if (dry) {
        r.created++;
        note(`${domain}: acilacak`);
        continue;
      }
      let props: Record<string, string> = { name: domain, domain };
      try {
        const info = process.env.APOLLO_API_KEY ? await enrichOrganization(domain) : null;
        if (info) {
          props = { ...(await desiredCompanyProps(info)), name: info.name || domain, domain };
        }
      } catch {
        /* Apollo hatasi sirket olusturmayi engellemesin — ciplak acilir */
      }
      await hs.createObject("company", props);
      r.created++;
      note(`${domain}: acildi${props.name !== domain ? ` ("${props.name}")` : ""}`);
    } catch (e: any) {
      r.errors++;
      note(`HATA ${domain}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  r.done = true;
  return r;
}

// ======================= TAKVIMDEN DEMO DEAL'LARI =======================
// Calendly API'sine BAGIMLI OLMAYAN yol: Calendly rezervasyonlari zaten
// organizatorun (demo@validfor.com) Google Takvim'ine dusuyor. Bu fonksiyon o
// etkinliklerden dogrudan Sales Pipeline'da "Unassigned" deal'i acar.
//
// Neden gerekli: CALENDLY_TOKEN yetki hatasi (403 Insufficient scope) verdiginde
// calendly.ts hicbir rezervasyonu goremiyor ve book edilen demolar CRM'e hic
// dusmuyor. Takvim yolu bu tek noktaya bagimliligi kaldirir.
//
// Kapsam: GELECEK etkinlikler (gecmis toplantilar Fireflies akisinin isi).
// Calendly imzasi tasiyanlar KESIN dahil; imzasizlar yalnizca basliginda
// "demo" gecerse alinir (ic toplantilar sizmasin).
export interface CalendarDemoResult {
  events: number;
  candidates: number;
  created: number;
  existing: number;
  errors: number;
  items: string[];
}

export function extractCalendarDemoCandidates(
  events: CalendarEvent[],
  nowMs: number,
): Array<{ domain: string; companyName: string; title: string; startMs: number }> {
  type Cand = { domain: string; companyName: string; title: string; startMs: number };
  const byKey = new Map<string, Cand>();
  const keep = (key: string, cand: Cand): void => {
    const cur = byKey.get(key);
    if (!cur || cand.startMs < cur.startMs) byKey.set(key, cand);
  };
  for (const ev of events) {
    if (ev.startMs <= nowMs) continue; // gecmis -> Fireflies akisi isler
    const title = ev.title.toLowerCase();
    // Calendly imzasi = kesin demo rezervasyonu. Imzasizsa yalniz "demo" basligi.
    if (!ev.isCalendly && !title.includes("demo")) continue;
    let hasCompanyDomain = false;
    let hasExternal = false;
    for (const email of ev.attendees) {
      if (isInternalEmail(email)) continue;
      hasExternal = true;
      const domain = emailDomain(email);
      if (!isCompanyDomain(domain)) continue;
      hasCompanyDomain = true;
      // companyName domain'li adayda da tasinir: kart adi olarak BEYAN EDILEN
      // ad tercih edilir (kart "thermofisher.com" degil "Thermo Fisher
      // Scientific" olur), domain ise sirket kaydinda kimlik olarak kalir.
      keep(domain, {
        domain,
        companyName: ev.companyName,
        title: ev.title,
        startMs: ev.startMs,
      });
    }
    // Serbest webmail'li rezervasyon (gmail/icloud): sirket domain'i YOK ama
    // Calendly formunda sirket adi var -> kart AD ile acilir. Webmail domain'i
    // hicbir zaman sirket kaydina donmez; kural korunur, yalnizca insanin
    // beyan ettigi ad kullanilir.
    if (!hasCompanyDomain && hasExternal && ev.companyName) {
      keep(`name:${ev.companyName.toLowerCase()}`, {
        domain: "",
        companyName: ev.companyName,
        title: ev.title,
        startMs: ev.startMs,
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Sirket kaydini bulur, yoksa acar. Oncelik: DOMAIN (sabit kimlik) -> AD.
 *
 * Ad aramasinda birebir esitlik yetmiyor: ayni firmadan iki kisi Calendly
 * formuna "Julphar" ve "Julphar Pharmaceutical" yazinca iki ayri sirket
 * aciliyordu. EQ tutmazsa CONTAINS_TOKEN ile aranip sameCompanyName ile
 * dogrulanir (upsert.ts'teki ayni desen, daha toleransli son kontrolle).
 *
 * webmail domain'i ASLA sirket kaydina yazilmaz — cagiran taraf domain'i
 * yalnizca kurumsal oldugunda gecirir.
 */
export async function findOrCreateCompany(domain: string, name: string): Promise<string> {
  if (domain) {
    const byDomain = await hs.searchByProperty("company", "domain", "EQ", domain, ["name"]);
    if (byDomain?.id) return String(byDomain.id);
  }
  if (name) {
    const byName = await hs.searchByProperty("company", "name", "EQ", name, ["name"]);
    if (byName?.id) return String(byName.id);
    // EQ buyuk/kucuk harf duyarli; ayrica "Julphar" != "Julphar Pharmaceutical"
    const alt = await hs.searchByProperty("company", "name", "CONTAINS_TOKEN", name, ["name"]);
    if (alt?.id && sameCompanyName(String(alt.properties?.name || ""), name)) {
      return String(alt.id);
    }
  }
  const props: Record<string, string> = { name: name || domain };
  if (domain) props.domain = domain;
  const created = await hs.createObject("company", props);
  return String(created.id);
}

/**
 * Bir toplantinin takvim etkinligindeki BEYAN EDILEN sirket adini bulur.
 *
 * Neden gerekli: kisisel e-postayla (gmail/icloud/hotmail) alinan demolarda
 * transkript yolu sirket kimligi bulamiyor ve kayit ATLANIYOR — 30 dakikalik
 * dolu bir demo bile CRM'e girmiyor (Abanoub/Julphar, Luis/LuceNox vakalari).
 * Bilgi aslinda elimizde: Calendly form cevaplarini takvim etkinliginin
 * aciklamasina yaziyor. Burada o adi toplanti saatine ve katilimciya gore
 * eslestirip transkript akisina geri veriyoruz.
 *
 * Hicbir hata pipeline'i dusurmez — bulunamazsa bos string doner.
 */
export async function findCalendarCompanyName(
  attendeeEmails: string[],
  meetingStartMs: number,
): Promise<string> {
  const ids = calendarIds();
  const wanted = new Set(
    attendeeEmails.map((e) => String(e || "").toLowerCase().trim()).filter(Boolean),
  );
  if (!ids.length || !wanted.size || !Number.isFinite(meetingStartMs)) return "";

  // Pencere: toplanti gecmisteyse pastDays, gelecekteyse days tarafi genisler.
  const diffDays = Math.ceil(Math.abs(Date.now() - meetingStartMs) / 86_400_000) + 1;
  const span = Math.min(Math.max(diffDays, 1), 90);
  const past = meetingStartMs <= Date.now() ? span : 1;
  const ahead = meetingStartMs > Date.now() ? span : 1;

  const TOLERANCE_MS = 2 * 60 * 60 * 1000; // takvim ve Fireflies saatleri birebir tutmayabilir
  for (const id of ids) {
    let events: CalendarEvent[] = [];
    try {
      events = await fetchUpcomingEvents(id, ahead, past);
    } catch {
      continue; // bir takvim okunamazsa digerlerine devam
    }
    for (const ev of events) {
      if (!ev.companyName) continue;
      if (Math.abs(ev.startMs - meetingStartMs) > TOLERANCE_MS) continue;
      if (!ev.attendees.some((e) => wanted.has(e))) continue;
      return ev.companyName;
    }
  }
  return "";
}

export async function syncCalendarDemoDeals(
  opts: { days?: number; dry?: boolean } = {},
): Promise<CalendarDemoResult> {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  const days = opts.days ?? 30;
  const dry = !!opts.dry;
  const ids = calendarIds();
  if (!ids.length) throw new Error("GOOGLE_CALENDAR_ID tanimli degil");

  const events: CalendarEvent[] = [];
  const calErrors: string[] = [];
  for (const id of ids) {
    try {
      events.push(...(await fetchUpcomingEvents(id, days, 0)));
    } catch (e: any) {
      calErrors.push(`${id}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  if (!events.length && calErrors.length) {
    throw new Error(`hicbir takvim okunamadi — ${calErrors.join(" | ")}`.slice(0, 500));
  }

  const candidates = extractCalendarDemoCandidates(events, Date.now());
  const r: CalendarDemoResult = {
    events: events.length,
    candidates: candidates.length,
    created: 0,
    existing: 0,
    errors: calErrors.length,
    items: [],
  };
  const note = (line: string): void => {
    if (r.items.length < 100) r.items.push(line);
  };
  for (const err of calErrors) note(`HATA takvim ${err}`);

  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
  for (const cand of candidates) {
    await sleep(350); // HubSpot arama limiti (4/sn) freni
    // Kart adi: insanin BEYAN ETTIGI sirket adi domain'e TERCIH EDILIR.
    // Kurumsal e-postada kart eskiden "thermofisher.com" gibi aciliyor ve ekip
    // sirket adiyla arayinca bulamiyordu. Domain kimlik olarak sirket kaydinda
    // saklanmaya devam eder (eslestirme ve Apollo zenginlestirme oradan calisir).
    const label = cand.companyName || cand.domain;
    try {
      // Mukerrer kontrolu HER IKI kimlikle: domain sabit kimliktir, ad ise
      // kartin gorunen adi. Biri tutmazsa digeri yakalar.
      const already =
        (cand.domain && (await findExistingDealForDomain(cand.domain, PIPELINE_ID))) ||
        (cand.companyName && (await findExistingDealForDomain(cand.companyName, PIPELINE_ID)));
      if (already) {
        r.existing++;
        continue;
      }
      const when = new Date(cand.startMs).toISOString().slice(0, 16).replace("T", " ");
      if (!dry) {
        const companyId = await findOrCreateCompany(cand.domain, label);
        // Kullanici kurali: book edilen demo "Unassigned"a duser; Scheduled'a
        // tasima karari EKIBIN. Toplanti gerceklesince otomasyon Meeting'e alir.
        const deal = await hs.createObject("deal", {
          dealname: label,
          pipeline: PIPELINE_ID,
          dealstage: STAGE.unassigned,
        });
        if (companyId) await hs.associateDefault("deal", String(deal.id), "company", companyId);
      }
      r.created++;
      note(`${label}: "${cand.title || "(bassiz)"}" @ ${when} UTC -> Sales deal (Unassigned)`);
    } catch (e: any) {
      r.errors++;
      note(`HATA ${label}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  return r;
}
