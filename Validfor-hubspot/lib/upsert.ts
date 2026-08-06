// Toplanti -> temiz HubSpot kaydi (bul-olustur, idempotent). DOMiNO'da bu mantik
// Claude Routine'in icindeydi; burada acik kod. Akis: harici sirket -> company ->
// contacts -> deal -> ff_* alanlar -> ozet not (+ transkript PDF).
import * as hs from "./hubspot.js";
import { buildTranscriptPDF } from "./pdf.js";
import { viewUrl } from "./fireflies.js";
import { applyVcCardFields, normKey } from "./vcfields.js";
import { enrichCompanyFromApollo } from "./company.js";
import type { Transcript } from "./fireflies.js";
import { extractFundProfile, type MeetingExtract } from "./classify.js";

const INTERNAL_DOMAINS = new Set(
  (process.env.VALIDFOR_INTERNAL_DOMAINS || "validfor.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Serbest e-posta saglayicilari sirket domaini SAYILMAZ (gmail vb. -> sirket
// olmaz, backfill de zenginlestirmez). Uluslararasi webmail'ler dahil —
// backfill onizlemesinde wp.pl ve 126.com'un "sirket" olarak dolacagi gorulup
// liste genisletildi.
export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.it", "yahoo.es",
  "yahoo.gr", "yahoo.com.tr", "yahoo.co.in", "ymail.com",
  "icloud.com", "me.com", "aol.com",
  "proton.me", "protonmail.com", "gmx.com", "gmx.de", "gmx.net",
  "yandex.com", "yandex.ru", "mail.ru",
  "wp.pl", "o2.pl", "onet.pl", "interia.pl", // Polonya webmail
  "126.com", "163.com", "qq.com", "foxmail.com", // Cin webmail (NetEase/Tencent)
  "web.de", "t-online.de", "libero.it", "orange.fr", "wanadoo.fr",
  "naver.com", "hanmail.net", "daum.net", "seznam.cz",
]);

// Sirket SAYILMAYAN domain'ler — iki ayri sebep:
//  1) TAKVIM ARTEFAKTI: Google Takvim'de toplanti odalari ve kaynaklar birer
//     "katilimci" olarak gelir (c_1234@resource.calendar.google.com,
//     ...@group.calendar.google.com). Gercek bir karsi taraf degildir.
//  2) TAKMA AD DOMAIN: gercek posta domaini ama ayri bir tuzel kisi degil —
//     xwf.google.com Google'in "Extended Workforce" (yuklenici) domaini; karsi
//     taraf Google'dir, ayri kayit acmak google.com ile duplikasyon yaratir.
const NON_COMPANY_DOMAIN_RE =
  /(^|\.)(resource\.calendar\.google\.com|group\.calendar\.google\.com|calendar\.google\.com)$|^xwf\.google\.com$/i;

/** true: bu domain bir sirket degil (takvim kaynagi / teknik artefakt). */
export function isNonCompanyDomain(domain: string): boolean {
  const d = String(domain || "").toLowerCase().trim();
  if (!d) return true;
  return NON_COMPANY_DOMAIN_RE.test(d);
}

/** Bu domain'den sirket/kisi kaydi acilabilir mi? (serbest webmail + artefakt haric) */
export function isCompanyDomain(domain: string): boolean {
  const d = String(domain || "").toLowerCase().trim();
  return Boolean(d) && !FREE_EMAIL_DOMAINS.has(d) && !isNonCompanyDomain(d);
}

// --- Saf yardimcilar (network yok; testlerde dogrulanabilir) ---
export function emailDomain(email: string): string {
  const at = String(email || "").lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase().trim();
}
export function isInternalEmail(email: string): boolean {
  return INTERNAL_DOMAINS.has(emailDomain(email));
}
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
// "saikiran.k@x.com" -> {firstName:"Saikiran", lastName:"K"} — son care isim kaynagi.
export function nameFromEmail(email: string): { firstName: string; lastName: string } {
  const local = String(email || "").split("@")[0] || "";
  const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : "");
  const parts = local
    .split(/[._\-+]+/)
    .filter((p) => p && !/^\d+$/.test(p)) // salt-rakam parcalari atla (jane.doe.1985)
    .map((p) => cap(p.toLowerCase()));
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
// "omer.cimen@validfor.com" -> "Omer Cimen" (deal_owner_validfor metni icin).
export function ownerNameFromEmail(email: string): string {
  const { firstName, lastName } = nameFromEmail(email);
  return [firstName, lastName].filter(Boolean).join(" ");
}

// Ortak/rol hesaplari GERCEK KISI DEGILDIR — asla deal owner olamaz.
// (Demolarin cogunu demo@validfor.com organize eder; owner "Demo" OLMAMALI.)
const SHARED_LOCALPARTS = new Set([
  "demo", "demo-requests", "demorequests", "connect", "info", "hello",
  "support", "sales", "admin", "team", "meetings", "noreply", "no-reply",
]);
export function isSharedAccountEmail(email: string): boolean {
  const local = String(email || "").split("@")[0].toLowerCase().trim();
  return SHARED_LOCALPARTS.has(local);
}
// Katilimcilardan ilk GERCEK Validfor kisisini bulur (ortak hesaplar haric).
// displayName varsa onu, yoksa e-postadan turetilmis adi doner; kimse yoksa "".
export function internalOwnerFromAttendees(t: Transcript): string {
  const candidates: Array<{ email: string; name?: string | null }> = [
    ...(t.meeting_attendees || []).map((a) => ({
      email: (a.email || "").toLowerCase().trim(),
      name: a.displayName || a.name,
    })),
    { email: (t.organizer_email || "").toLowerCase().trim() },
    { email: (t.host_email || "").toLowerCase().trim() },
  ];
  for (const c of candidates) {
    if (!c.email || !isInternalEmail(c.email) || isSharedAccountEmail(c.email)) continue;
    const fromDisplay = String(c.name || "").trim();
    if (fromDisplay) return fromDisplay;
    const derived = ownerNameFromEmail(c.email);
    if (derived) return derived;
  }
  return "";
}
function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function buildNoteBody(x: MeetingExtract, link: string, ffId?: string): string {
  let html = `<p><strong>Meeting summary</strong></p><p>${escapeHtml(x.summary)}</p>`;
  if (x.nextSteps && x.nextSteps.length) {
    html +=
      `<p><strong>Next steps</strong></p><ul>` +
      x.nextSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join("") +
      `</ul>`;
  }
  // fireflies link (ULID iceren) -> hem gorunur hem idempotency arama anahtari
  html += `<p>Fireflies: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`;
  // Ciplak ULID'i ayri bir token olarak da yaz: CONTAINS_TOKEN aramasi URL icine
  // gomulu ULID'i tokenize edemezse bile bu satiri bulur.
  if (ffId) html += `<p>FF-ID: ${escapeHtml(ffId)}</p>`;
  return html;
}
export function meetingDateMs(t: Transcript): number {
  let d: Date;
  if (t.dateString) d = new Date(t.dateString);
  else if (t.date != null) d = new Date(typeof t.date === "number" ? t.date : Number(t.date));
  else d = new Date();
  if (isNaN(d.getTime())) d = new Date();
  return d.getTime();
}
// HubSpot 'date' tipi: gece yarisi UTC epoch ms bekler.
export function midnightUtcMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function sanitizeFilename(s: string): string {
  const clean = String(s || "transcript").replace(/[^\w.\- ]+/g, "_").trim().slice(0, 80);
  return clean || "transcript";
}

// --- Sales Pipeline stage otomasyonu (2026-07 pipeline yeniden yapilanmasi) ---
// Sales Pipeline (id=default): Unassigned -> Scheduled -> Meeting -> Follow-Up ->
// Contract -> PoC -> Won/Lost. Akis (kullanici karari):
//   Unassigned/Scheduled : ELLE yonetilir (takim karar verip tasir)
//   Meeting              : toplanti GERCEKLESINCE otomatik
//   Follow-Up            : ayni deal'a IKINCI toplanti gelince otomatik
//   Contract/PoC/Won/Lost: tamamen manuel — otomasyon DOKUNMAZ
// DIKKAT: Ic ID'ler etiketlerle uyusmaz (HubSpot yeniden adlandirmada ID korunur):
// "Follow-Up"=closedwon, "Contract"=decisionmakerboughtin, "PoC"=contractsent.
export const PIPELINE_ID = "default";
export const STAGE = {
  unassigned: "appointmentscheduled", // 0 — elle
  scheduled: "qualifiedtobuy", //        1 — elle
  meeting: "5732504815", //              2 — AUTO: toplanti gerceklesti
  followUp: "closedwon", //              3 — AUTO: ikinci toplanti (follow-up yapildi)
} as const;

// Ayri "VC Pipeline": yatirimci gorusmeleri (meetingType=investor) buraya
// yonlenir. Stage otomasyonu Sales'in aynasi (2026-07 VC yapisi: Contacted ->
// Meeting -> Follow-up -> Due Diligence -> Term Sheet Received -> Closed
// Won/Lost + Not Priority):
//   Contacted             : ELLE (outreach takibi)
//   Meeting               : toplanti GERCEKLESINCE otomatik
//   Follow-up             : ayni fonla IKINCI toplantida otomatik
//   Due Diligence ve otesi: tamamen manuel — otomasyon DOKUNMAZ
// Kart ("About VC") alanlari vcfields uzerinden bos-alan kuraliyla dolar —
// kartin SON alani (Likelihood) bilincli MANUEL.
export const VC_PIPELINE_ID = "3976227025";
export const VC_STAGE = {
  contacted: "5732106484", // 0 — elle
  meeting: "5732106485", //   1 — AUTO: toplanti gerceklesti
  followUp: "5732106486", //  2 — AUTO: ikinci toplanti
} as const;
export const VC_STAGE_MEETING = VC_STAGE.meeting;

const VC_STAGE_ORDER: Record<string, number> = {
  [VC_STAGE.contacted]: 0,
  [VC_STAGE.meeting]: 1,
  [VC_STAGE.followUp]: 2,
};

// Sales'teki computeDealStage'in VC aynasi (SAF — test edilebilir). Listede
// OLMAYAN her stage (Due Diligence/Term Sheet/Won/Lost/Not Priority/bilinmeyen)
// = MANUEL -> null (dokunma). Asla geri goturmez.
export function computeVcDealStage(currentStage: string): string | null {
  const cur = String(currentStage || "").trim();
  if (cur && !(cur in VC_STAGE_ORDER)) return null;
  if (!cur || cur === VC_STAGE.contacted) return VC_STAGE.meeting;
  if (cur === VC_STAGE.meeting) return VC_STAGE.followUp;
  // Follow-up ve sonrasi: otomasyon ilerletmez.
  return null;
}

// Otomasyonun bildigi stage'ler. Listede OLMAYAN her stage (Contract/PoC/
// Won/Lost/bilinmeyen) = MANUEL -> dokunma.
const STAGE_ORDER: Record<string, number> = {
  [STAGE.unassigned]: 0,
  [STAGE.scheduled]: 1,
  [STAGE.meeting]: 2,
  [STAGE.followUp]: 3,
};

// "No show" stage'i ETIKETTEN cozulur (id sabitlenmez: pipeline sik yeniden
// yapilandiriliyor; silinip yeniden olusturulursa id degisir). Onbellekli;
// bulunamazsa "" doner ve no-show tasimasi sessizce atlanir.
let noShowStageCache: Promise<string> | null = null;
export function resolveNoShowStageId(): Promise<string> {
  if (!noShowStageCache) {
    noShowStageCache = hs
      .hsFetch<{ results?: any[] }>("/crm/v3/pipelines/deals")
      .then((j) => {
        const def = (j.results || []).find((p: any) => String(p.id) === PIPELINE_ID);
        const st = (def?.stages || []).find(
          (s: any) => normKey(String(s?.label || "")) === "noshow",
        );
        return st ? String(st.id) : "";
      })
      .catch((e) => {
        noShowStageCache = null; // sonraki kosum tekrar denesin
        throw e;
      });
  }
  return noShowStageCache;
}

// ff_processed_transcripts (deal property) — islenmis transkript ULID listesi.
// Deal uzerinde GET ile okunur (guclu tutarli) -> arama indeksinin gecikmesine
// bagli mukerrer islemeyi keser. Sinirsiz buyumesin diye son 60 ULID tutulur.
const PROCESSED_PROP = "ff_processed_transcripts";
const PROCESSED_MAX = 60;
export function parseProcessedList(raw: string | null | undefined): string[] {
  return String(raw || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
export function appendProcessed(raw: string | null | undefined, id: string): string {
  const list = parseProcessedList(raw);
  if (!list.includes(id)) list.push(id);
  return list.slice(-PROCESSED_MAX).join(";");
}

// Kucuk esli paralellik: items'i n'lik gruplar halinde isler (HubSpot arama
// limiti ~4-5 istek/sn oldugu icin dar tutulur; 429'da hsFetch retry devrede).
async function mapChunked<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const part = await Promise.all(items.slice(i, i + size).map(fn));
    out.push(...part);
  }
  return out;
}

// Yeni bir toplanti islenirken hedef stage'i hesaplar (SAF — test edilebilir).
//   currentStage: deal'in su anki dealstage ic ID'si ("" = yeni deal)
// Doner: set edilecek stage ID; null -> stage'e DOKUNMA (manuel bolge / ilerleme yok).
export function computeDealStage(currentStage: string): string | null {
  const cur = String(currentStage || "").trim();
  // Manuel bolge (Contract/PoC/Won/Lost/bilinmeyen) -> insan devralmis, dokunma.
  if (cur && !(cur in STAGE_ORDER)) return null;
  // Yeni deal ya da elle-yonetilen giris stage'leri: toplanti gerceklesti -> Meeting.
  if (!cur || STAGE_ORDER[cur] <= STAGE_ORDER[STAGE.scheduled]) return STAGE.meeting;
  // Meeting'de yeni toplanti = follow-up yapildi -> Follow-Up.
  if (cur === STAGE.meeting) return STAGE.followUp;
  // Follow-Up ve sonrasi: otomasyon ilerletmez.
  return null;
}

export interface UpsertResult {
  status: "created" | "updated" | "skipped";
  companyId: string | null;
  dealId: string | null;
  contactIds: string[];
  noteId: string | null;
  meetingId?: string | null;
  fireflies_link: string;
  reason?: string;
}

export async function upsertMeeting(
  t: Transcript,
  x: MeetingExtract,
): Promise<UpsertResult> {
  const link = viewUrl(t.id);
  const base = {
    companyId: null as string | null,
    dealId: null as string | null,
    contactIds: [] as string[],
    noteId: null as string | null,
    fireflies_link: link,
  };

  // Harici katilimcilar (Validfor-ici olmayanlar)
  const uniqueExternal = Array.from(
    new Set(
      (t.meeting_attendees || [])
        .map((a) => (a.email || "").toLowerCase().trim())
        .filter(Boolean)
        .filter((e) => !isInternalEmail(e)),
    ),
  );
  const companyDomain =
    uniqueExternal.map(emailDomain).find((d) => isCompanyDomain(d)) || "";

  // Harici taraf yoksa (tamamen ici) ve sirket adi da yoksa -> atla
  if (!companyDomain && !x.companyName) {
    return { ...base, status: "skipped", reason: "harici sirket/katilimci yok" };
  }

  // Idempotency isareti 1 (legacy/yedek): bu transkript ID'sini iceren not var mi?
  // (Arama indeksi gecikmeli olabilir; asil guclu tutarli isaret asagida deal
  // uzerindeki ff_processed_transcripts ile okunur.)
  const existingNotes = await hs.searchNotes({ contains: t.id, limit: 1 });
  const legacyNoteExists = (existingNotes.results || []).length > 0;

  // 1) Company bul-olustur (once domain, sonra ad). Sonunda daima dolu.
  // Zenginlestirme: country yalnizca bossa yazilir (insan verisi ezilmez).
  let companyId = "";
  let companyCountry: string | null = null; // bulunan kayittaki mevcut deger
  if (companyDomain) {
    const c = await hs.searchByProperty("company", "domain", "EQ", companyDomain, [
      "name",
      "domain",
      "country",
    ]);
    companyId = c?.id || "";
    if (companyId) companyCountry = String(c.properties?.country || "");
  }
  if (!companyId && x.companyName) {
    const c = await hs.searchByProperty("company", "name", "EQ", x.companyName, [
      "name",
      "country",
    ]);
    companyId = c?.id || "";
    if (companyId) companyCountry = String(c.properties?.country || "");
    if (!companyId) {
      // EQ buyuk/kucuk harf duyarli: "freshworks" vs "Freshworks" mukerrer sirket
      // yaratmasin diye normalize edilmis tam-eslesme fallback'i (deal aramasiyla tutarli).
      const want = x.companyName.trim().toLowerCase();
      const alt = await hs.searchByProperty(
        "company", "name", "CONTAINS_TOKEN", x.companyName, ["name", "country"],
      );
      if (alt && String(alt.properties?.name || "").trim().toLowerCase() === want) {
        companyId = alt.id;
        companyCountry = String(alt.properties?.country || "");
      }
    }
  }
  if (!companyId) {
    const props: Record<string, string> = { name: x.companyName || companyDomain };
    if (companyDomain) props.domain = companyDomain;
    if (x.country) props.country = x.country;
    const created = await hs.createObject("company", props);
    companyId = String(created.id);
  } else if (x.country && !String(companyCountry || "").trim()) {
    await hs.updateObject("company", companyId, { country: x.country });
  }

  // 1b) Sirket alanlarini Apollo organizations/enrich ile tamamla: website,
  // LinkedIn sayfasi, sektor, calisan sayisi, telefon, sehir/ulke — yalniz BOS
  // alanlar (transkriptten yazilan country dahil, dolu olan ezilmez).
  // Destekleyici adim: APOLLO_API_KEY yoksa sessizce atlanir, hata akisi durdurmaz.
  if (companyDomain) {
    try {
      await enrichCompanyFromApollo(companyId, companyDomain);
    } catch (e: any) {
      console.error("[upsert] Apollo sirket zenginlestirme atlandi:", e?.message || e);
    }
  }

  // 2) Contacts bul-olustur + zenginlestir + company iliskisi (4'lu gruplar
  // halinde paralel — 20+ katilimcili toplantilar 60s butcesine sigsin).
  // Zenginlestirme kurali: var olan kayitta YALNIZCA BOS alanlar doldurulur
  // (insanin girdigi veri asla ezilmez); Claude'un bos biraktigi alan yazilmaz.
  const CONTACT_PROPS = [
    "email", "firstname", "lastname", "phone", "company",
    "preferred_validation_module", "role_in_validation",
    "validation_budget_range", "ai_adoption_readiness",
  ];
  const companyLabel = x.companyName || companyDomain;
  const profileByEmail = new Map(x.attendeeProfiles.map((p) => [p.email, p]));

  const contactIds = await mapChunked(uniqueExternal, 4, async (email) => {
    const att = (t.meeting_attendees || []).find(
      (a) => (a.email || "").toLowerCase().trim() === email,
    );
    const prof = profileByEmail.get(email);
    // Isim onceligi: Fireflies displayName > Claude cikarimi > e-posta local-part
    let { firstName, lastName } = splitName(att?.displayName || att?.name || "");
    if (!firstName && prof?.firstName) {
      firstName = prof.firstName;
      lastName = prof.lastName;
    }
    if (!firstName) ({ firstName, lastName } = nameFromEmail(email));

    const desired: Record<string, string> = {};
    if (firstName) desired.firstname = firstName;
    if (lastName) desired.lastname = lastName;
    if (prof?.phone) desired.phone = prof.phone;
    if (companyLabel) desired.company = companyLabel;
    if (prof?.preferredValidationModule)
      desired.preferred_validation_module = prof.preferredValidationModule;
    if (prof?.roleInValidation) desired.role_in_validation = prof.roleInValidation;
    if (prof?.validationBudgetRange)
      desired.validation_budget_range = prof.validationBudgetRange;
    if (prof?.aiAdoptionReadiness)
      desired.ai_adoption_readiness = prof.aiAdoptionReadiness;

    const found = await hs.searchByProperty("contact", "email", "EQ", email, CONTACT_PROPS);
    let cid: string = found?.id || "";
    if (!cid) {
      try {
        const created = await hs.createObject("contact", { email, ...desired });
        cid = String(created.id);
      } catch (e: any) {
        // 409: kayit zaten var (ikincil e-posta ya da es zamanli olusturma).
        // HubSpot mesajindaki "Existing ID: <n>"den kurtar; yoksa firlat.
        const m = /Existing ID:\s*(\d+)/i.exec(
          String(e?.body?.message || e?.message || ""),
        );
        if (e?.status === 409 && m) cid = m[1];
        else throw e;
      }
    } else {
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(desired)) {
        if (!String(found.properties?.[k] || "").trim()) patch[k] = v;
      }
      if (Object.keys(patch).length) await hs.updateObject("contact", cid, patch);
    }
    if (companyId) await hs.associateDefault("contact", cid, "company", companyId);
    return cid;
  });

  // 3) Deal bul-olustur + iliskiler.
  // dealName ASLA toplanti basligina dusmemeli (baslik her toplantida degisir ->
  // sirket basina toplanti sayisi kadar mukerrer deal): sirket adi yoksa domain.
  // ONEMLI: stage BURADA ILERLETILMEZ; idempotency isaretleri yazildiktan sonra
  // (adim 6). Aksi halde "stage ilerledi ama isaret yok" durumunda retry ayni
  // toplantiyi tekrar ilerletirdi.
  const dealName = x.companyName || companyDomain || t.title || "Meeting";
  let foundDeal = await hs.searchDealsByName(dealName);
  // Takvim senkronu (gcal) deal'i DOMAIN adiyla acar (guzel ad henuz bilinmez).
  // Ad aramasi bos donerse domain adiyla da ara — ayni fona mukerrer deal acilmasin.
  if (!foundDeal && companyDomain && dealName.toLowerCase() !== companyDomain) {
    foundDeal = await hs.searchDealsByName(companyDomain);
  }
  // SON CARE — SIRKETE BAGLI DEAL: ad aramasi Claude'un her transkriptte biraz
  // farkli cikardigi adlarda ("Knight TX" / "Knight Therapeutics", "Redalpine" /
  // "Red Alpine") tutmaz ve ayni sirkete IKINCI deal acilirdi (14 mukerrer
  // olcuLdu). Sirketin bagli deal'lari arasinda AYNI pipeline'dakini benimse.
  if (!foundDeal && companyId) {
    const wantPipeline = x.meetingType === "investor" ? VC_PIPELINE_ID : PIPELINE_ID;
    try {
      const dealIds = (await hs.getAssociations("company", companyId, "deal")).slice(0, 25);
      for (const id of dealIds) {
        const cand = await hs.getObject("deal", id, ["dealname", "pipeline"]);
        if (String(cand?.properties?.pipeline || "") === wantPipeline) {
          foundDeal = cand;
          break;
        }
      }
    } catch (e: any) {
      console.error("[upsert] sirkete bagli deal aranamadi:", e?.message || e);
    }
  }
  let dealId: string = foundDeal?.id || "";
  const foundDealName = String(foundDeal?.properties?.dealname || "").trim();

  // Var olan deal'in stage/processed/tarih durumunu CANLI oku (GET guclu tutarli).
  // Aramanin dondurdugu property snapshot'i dakikalarca eski olabilir: yanlis
  // stage'den ilerletme ya da az once manuel tasinmis deal'a dokunma riski.
  const isInvestor = x.meetingType === "investor";
  let currentStage = "";
  let dealPipeline = "";
  let processedRaw = "";
  let storedDateMs: number | null = null;
  let vcStageJustSet = false; // yeni VC deal'i: stage create'te yazildi, adim 6 dokunmasin
  const cur: Record<string, string> = {}; // yalniz-bossa-yaz alanlarinin mevcut degerleri
  const ENRICH_PROPS = [
    "deal_owner_validfor", "dealtype", "amount", "sector", "icp",
    "headcount", "solution_which_competitor_they_use",
  ];
  if (dealId) {
    const live = await hs.getObject("deal", dealId, [
      "dealstage",
      "pipeline",
      PROCESSED_PROP,
      "ff_last_meeting_date",
      ...ENRICH_PROPS,
    ]);
    currentStage = String(live?.properties?.dealstage || "");
    dealPipeline = String(live?.properties?.pipeline || "");
    processedRaw = String(live?.properties?.[PROCESSED_PROP] || "");
    for (const k of ENRICH_PROPS) cur[k] = String(live?.properties?.[k] || "").trim();
    const rawDate = live?.properties?.ff_last_meeting_date;
    if (rawDate) {
      const parsed = new Date(String(rawDate)).getTime();
      if (!isNaN(parsed)) storedDateMs = parsed;
    }
  } else if (isInvestor) {
    // Yatirimci gorusmesi -> VC Pipeline'da ac, dogrudan "Meeting" (toplanti
    // gerceklesti). DIKKAT: currentStage'e Meeting YAZILMAZ — adim 6 onu
    // "onceki toplanti" sanip AYNI toplantiyi Follow-up'a ilerletiyordu
    // (ilk-toplanti kurali ihlali). Bunun yerine vcStageJustSet bayragiyla
    // adim 6 tamamen atlanir.
    const created = await hs.createObject("deal", {
      dealname: dealName,
      pipeline: VC_PIPELINE_ID,
      dealstage: VC_STAGE.meeting,
    });
    dealId = String(created.id);
    dealPipeline = VC_PIPELINE_ID;
    vcStageJustSet = true;
  } else {
    // Yeni satis deal'i: pipeline'a yaz, stage HubSpot varsayilan girisinde
    // kalir; gercek stage adim 6'da isaretler yazildiktan sonra set edilir.
    const created = await hs.createObject("deal", {
      dealname: dealName,
      pipeline: PIPELINE_ID,
    });
    dealId = String(created.id);
    dealPipeline = PIPELINE_ID;
  }

  // Idempotency: guclu tutarli isaret (deal property, GET ile okundu) + legacy
  // not aramasi (eski kayitlar + property-patch'i tamamlanamamis kosumlar icin).
  const alreadyProcessed =
    parseProcessedList(processedRaw).includes(t.id) || legacyNoteExists;

  if (companyId) await hs.associateDefault("deal", dealId, "company", companyId);
  await mapChunked(contactIds, 4, (cid) =>
    hs.associateDefault("deal", dealId, "contact", cid),
  );

  // 4) Ozet not + transkript PDF — yalnizca daha once islenmediyse (idempotent
  // MARKER #1). Iliskiler create govdesinde INLINE: not ya tam bagli olusur ya
  // hic olusmaz (create->associate arasi cokme oksuz not birakamaz).
  const mMs = meetingDateMs(t);
  let noteId: string | null = null;
  if (!alreadyProcessed) {
    const pdf = await buildTranscriptPDF(t);
    const fileId = await hs.uploadFile(pdf, `${sanitizeFilename(t.title || t.id)}.pdf`);
    noteId = await hs.createNote({
      body: buildNoteBody(x, link, t.id),
      timestamp: mMs,
      attachmentIds: fileId,
      associations: {
        ...(companyId ? { company: [companyId] } : {}),
        deal: [dealId],
        contact: contactIds,
      },
    });
  }

  // 4b) Meeting engagement — yalnizca yeni toplantida. Not'tan farki: loglanan
  // meeting HubSpot'un "Last Contacted"/"Last Activity" hesaplanan alanlarini
  // gunceller (o alanlar dogrudan yazilamaz). Destekleyici adim: scope yoksa
  // (403) akisi DURDURMAZ.
  let meetingId: string | null = null;
  if (!alreadyProcessed) {
    try {
      const durMin = Number(t.duration);
      const endMs =
        !isNaN(durMin) && durMin > 0 ? mMs + Math.round(durMin * 60000) : undefined;
      meetingId = await hs.createMeeting({
        title: t.title || "Meeting",
        body: `${x.summary}\n\nFireflies: ${link}`,
        startMs: mMs,
        endMs,
        // Karsi taraf gelmediyse engagement da NO_SHOW olarak loglanir
        outcome: x.externalAttended ? "COMPLETED" : "NO_SHOW",
      });
      if (companyId) await hs.associateDefault("meeting", meetingId, "company", companyId);
      await hs.associateDefault("meeting", meetingId, "deal", dealId);
      const mid = meetingId;
      await mapChunked(contactIds, 4, (cid) =>
        hs.associateDefault("meeting", mid, "contact", cid),
      );
    } catch (e: any) {
      console.error("[upsert] meeting engagement olusturulamadi:", e?.message || e);
      meetingId = null;
    }
  }

  // 5) Islenmis-isareti (MARKER #2, guclu tutarli) + ff_* + deal zenginlestirme
  // — tek PATCH, not'tan SONRA (bu adim patlarsa not var -> legacy arama tekrar
  // islemeyi keser). ff_* yalnizca bu toplanti kayitli son toplantidan yeni/ayni
  // gunse yazilir: geciken webhook / backfill edilen ESKI transkript "son
  // toplanti"yi ezmesin. Owner/dealtype/amount yalnizca BOSSA yazilir.
  const newDateMs = midnightUtcMs(mMs);
  const isNewest = storedDateMs == null || newDateMs >= storedDateMs;
  const patch: Record<string, unknown> = {
    [PROCESSED_PROP]: appendProcessed(processedRaw, t.id),
  };
  if (isNewest) {
    patch.ff_last_meeting_date = newDateMs;
    patch.ff_last_meeting_summary = x.summary;
    patch.ff_fireflies_link = link;
  }
  // Owner: Claude'un tespit ettigi "toplantiyi yoneten kisi" > gercek dahili
  // katilimci. Ortak hesap adlari (Demo/Connect vb.) asla owner olamaz;
  // gercek kisi bulunamazsa alan BOS kalir ("Demo" yazilmaz).
  let ownerName = x.meetingOwner.trim();
  if (!ownerName || /^(demo( requests)?|connect|validfor|support|sales|info)$/i.test(ownerName)) {
    ownerName = internalOwnerFromAttendees(t);
  }
  // Takvimden domain adiyla acilmis deal, gercek sirket adi ogrenilince
  // yeniden adlandirilir (yalniz ad hala domain'e esitse — insan adi ezilmez).
  if (x.companyName && foundDealName && foundDealName.toLowerCase() === companyDomain) {
    patch.dealname = x.companyName;
  }
  if (ownerName && !cur.deal_owner_validfor) patch.deal_owner_validfor = ownerName;
  // Sales kart alanlari YALNIZ Sales Pipeline deal'ina yazilir (VC kartinda bu
  // alanlar yok). Kartin SON 3 alani (Likelihood / Demo Status / Validfor
  // Priority) bilincli MANUEL — otomasyon hicbirine yazmaz (insan degerlendirmesi).
  if (dealPipeline === PIPELINE_ID) {
    if (x.dealType && !cur.dealtype) patch.dealtype = x.dealType;
    if (x.dealAmount != null && !cur.amount) patch.amount = x.dealAmount;
    if (x.sector && !cur.sector) patch.sector = x.sector;
    if (x.icp && !cur.icp) patch.icp = x.icp;
    if (x.headcount != null && !cur.headcount) patch.headcount = x.headcount;
    if (x.competitorSolution && !cur.solution_which_competitor_they_use) {
      patch.solution_which_competitor_they_use = x.competitorSolution;
    }
  }
  await hs.updateObject("deal", dealId, patch);

  // 5b) VC kart ("About VC") alanlari — yalniz VC Pipeline deal'lari. Ic adlar
  // canli property listesinden ETIKETE gore cozulur; bos-alan kurali gecerli;
  // kartin SON alani (Likelihood) MANUEL — vcfields ona hic dokunmaz.
  // Destekleyici adim: patlarsa akisi DURDURMAZ (isaretler zaten yazildi).
  if (dealPipeline === VC_PIPELINE_ID) {
    try {
      // Bosluk yakalayici: genel cikarim fon profili alanlarindan bazilarini
      // bos biraktiysa ve transkript doluysa, YALNIZCA fon profilini soran dar
      // bir ikinci cikarim yapilir; sonuc sadece BOS alanlari tamamlar (genel
      // cikarimin buldugu degerler ezilmez). Odakli soru, 20 alanli genel
      // cikarimin kacirdigi detayi yakalar. Yalniz yeni toplantida calisir.
      let vc = x;
      const hasGap =
        !x.investmentVerticals.length || !x.investmentStages.length ||
        !x.investmentRegions.length || x.minTicketSize == null ||
        x.maxTicketSize == null || !x.investmentType;
      if (hasGap && !alreadyProcessed && (t.sentences || []).length >= 30) {
        try {
          const fp = await extractFundProfile(t);
          vc = {
            ...x,
            investmentVerticals: x.investmentVerticals.length
              ? x.investmentVerticals : fp.investmentVerticals,
            investmentStages: x.investmentStages.length
              ? x.investmentStages : fp.investmentStages,
            investmentRegions: x.investmentRegions.length
              ? x.investmentRegions : fp.investmentRegions,
            minTicketSize: x.minTicketSize ?? fp.minTicketSize,
            maxTicketSize: x.maxTicketSize ?? fp.maxTicketSize,
            investmentType: x.investmentType || fp.investmentType,
          };
        } catch (e: any) {
          console.error("[upsert] fon profili ikinci gecisi basarisiz:", e?.message || e);
        }
      }
      await applyVcCardFields(dealId, vc);
    } catch (e: any) {
      console.error("[upsert] VC kart alanlari yazilamadi:", e?.message || e);
    }
  }

  // 6) Stage ilerlet — YALNIZCA yeni toplantida, isaretler yazildiktan SONRA.
  // Sales ve VC pipeline'lari kendi (ayna) kurallariyla ilerler; iki hesap da
  // manuel bolgede null doner ve asla geri gitmez. Baska pipeline'a dokunulmaz.
  //
  // No-show kurali (kullanici karari): karsi taraftan KIMSE katilmadiysa
  // (externalAttended=false) toplanti SAYILMAZ — deal Meeting'e ILERLEMEZ;
  // giris bolgesindeyse (bos/Unassigned/Scheduled) "No show" stage'ine tasinir.
  // Sonradan GERCEK bir toplanti gelirse No show'daki deal Meeting'e doner.
  if (!alreadyProcessed && dealPipeline === PIPELINE_ID) {
    let targetStage: string | null = null;
    if (!x.externalAttended) {
      const inEntry =
        !currentStage ||
        currentStage === STAGE.unassigned ||
        currentStage === STAGE.scheduled;
      if (inEntry) {
        try {
          const ns = await resolveNoShowStageId();
          if (ns && ns !== currentStage) targetStage = ns;
        } catch (e: any) {
          console.error("[upsert] No show stage cozulemedi:", e?.message || e);
        }
      }
    } else {
      // Gercek toplanti: No show'da bekleyen deal hayata doner -> giris gibi ele al.
      let cur = currentStage;
      try {
        if (cur && cur === (await resolveNoShowStageId())) cur = "";
      } catch {
        /* cozulemezse normal akis */
      }
      targetStage = computeDealStage(cur);
    }
    if (targetStage && targetStage !== currentStage) {
      await hs.updateObject("deal", dealId, {
        pipeline: PIPELINE_ID,
        dealstage: targetStage,
      });
    }
  } else if (
    !alreadyProcessed &&
    dealPipeline === VC_PIPELINE_ID &&
    !vcStageJustSet &&
    x.externalAttended // no-show VC toplantisi da ilerleme SAYILMAZ (No show stage'i yok, yerinde kalir)
  ) {
    // vcStageJustSet: deal bu kosumda Meeting stage'iyle YENI acildi — ayni
    // toplanti "ikinci toplanti" sayilip Follow-up'a ilerletilmemeli.
    // Ayni tuzagin takvim varyanti: calendar-sync GECMIS toplantiyi dogrudan
    // Meeting'de acar. O toplantinin transkripti sonradan islenirse (webhook
    // gec kaldi / replay), islenmis transkript listesi BOSken gelen bu ILK
    // transkript Meeting'i sahiplenir — Follow-up'a ilerletmez.
    const firstTranscriptClaimsMeeting =
      currentStage === VC_STAGE.meeting && parseProcessedList(processedRaw).length === 0;
    const targetStage = firstTranscriptClaimsMeeting ? null : computeVcDealStage(currentStage);
    if (targetStage && targetStage !== currentStage) {
      await hs.updateObject("deal", dealId, {
        pipeline: VC_PIPELINE_ID,
        dealstage: targetStage,
      });
    }
  }

  return {
    status: alreadyProcessed ? "updated" : "created",
    companyId,
    dealId,
    contactIds,
    noteId,
    meetingId,
    fireflies_link: link,
  };
}
