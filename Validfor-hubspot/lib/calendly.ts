// Calendly -> HubSpot Sales Pipeline: planlanmis demolar toplanti OLMADAN once
// "Unassigned" stage'inde deal olarak acilir (kullanici karari: Scheduled'a
// tasima ekibin elle verdigi karardir).
//
// Kural (kullanici karari): Calendly uzerinden rezerve edilen HER toplanti
// DEMO'dur. Ayni etkinlik ekibin Google takvimlerine de dustugu icin gcal
// senkronu Calendly kaynakli etkinlikleri VC adayi SAYMAZ (isCalendly filtresi)
// — boylece Calendly demolari Sales'e, takvimdeki fon toplantilari VC'ye gider.
//
// Demo gerceklesince Fireflies akisi domain-adli deal'i bulur (upsert'teki
// domain-ad fallback'i), gercek sirket adiyla yeniden adlandirir ve stage
// otomasyonu Unassigned/Scheduled -> Meeting'e tasir. Env: CALENDLY_TOKEN (PAT).
import * as hs from "./hubspot.js";
import {
  emailDomain,
  isInternalEmail,
  FREE_EMAIL_DOMAINS,
  isCompanyDomain,
  PIPELINE_ID,
  STAGE,
} from "./upsert.js";
import { findExistingDealForDomain } from "./gcal.js";

const BASE = "https://api.calendly.com";

async function cFetch<T = any>(url: string): Promise<T> {
  const token = process.env.CALENDLY_TOKEN;
  if (!token) throw new Error("CALENDLY_TOKEN tanimli degil");
  const res = await fetch(url.startsWith("http") ? url : BASE + url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Calendly ${res.status} ${url.split("?")[0]}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

export interface CalendlyEvent {
  id: string;
  title: string;
  startMs: number;
  uri: string;
}

// Calendly scheduled_events yanitini normalize eder (SAF).
export function normalizeCalendlyEvents(collection: any[]): CalendlyEvent[] {
  const out: CalendlyEvent[] = [];
  for (const ev of collection || []) {
    if (ev?.status && ev.status !== "active") continue; // iptaller atlanir
    const startMs = new Date(String(ev?.start_time || "")).getTime();
    if (isNaN(startMs)) continue;
    const uri = String(ev?.uri || "");
    out.push({
      id: uri.split("/").pop() || uri,
      title: String(ev?.name || "").trim(),
      startMs,
      uri,
    });
  }
  return out;
}

export interface DemoCandidate {
  domain: string;
  title: string;
  startMs: number;
}

// Davetli e-postalarindan demo adaylarini cikarir: harici + sirket domain'li
// davetliler; ayni sirket icin EN ERKEN rezervasyon tutulur (SAF).
// Serbest e-posta (gmail vb.) ile rezerve edenler sirketsiz kalir -> atlanir
// (deal'i zaten toplanti gerceklesince Fireflies akisi acar).
export function extractDemoCandidates(
  events: Array<{ title: string; startMs: number; emails: string[] }>,
  nowMs: number,
): DemoCandidate[] {
  const byDomain = new Map<string, DemoCandidate>();
  for (const ev of events) {
    if (ev.startMs <= nowMs) continue; // gecmis -> Fireflies akisinin isi
    for (const email of ev.emails) {
      if (isInternalEmail(email)) continue;
      const domain = emailDomain(email);
      if (!isCompanyDomain(domain)) continue;
      const cur = byDomain.get(domain);
      if (!cur || ev.startMs < cur.startMs) {
        byDomain.set(domain, { domain, title: ev.title, startMs: ev.startMs });
      }
    }
  }
  return [...byDomain.values()];
}

export interface CalendlySyncResult {
  events: number; //     okunan gelecek rezervasyon
  candidates: number; // sirket domain'li demo adayi
  created: number; //    acilan deal (dry'da: acilacak)
  existing: number; //   zaten deal'i var -> dokunulmadi
  errors: number;
  items: string[];
}

export async function syncCalendlyDemoDeals(
  opts: { days?: number; dry?: boolean } = {},
): Promise<CalendlySyncResult> {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  const days = opts.days ?? 30;
  const dry = !!opts.dry;

  // Kullanici + organizasyon: org genis listeleme (tum ekibin rezervasyonlari)
  // yetki gerektirir; olmazsa kullanicinin kendi etkinliklerine duser.
  const me = await cFetch<any>("/users/me");
  const userUri = String(me?.resource?.uri || "");
  const orgUri = String(me?.resource?.current_organization || "");
  const min = new Date().toISOString();
  const max = new Date(Date.now() + days * 86_400_000).toISOString();
  const qs = `min_start_time=${encodeURIComponent(min)}&max_start_time=${encodeURIComponent(max)}&status=active&count=100`;
  let collection: any[] = [];
  try {
    if (!orgUri) throw new Error("organizasyon URI yok");
    const j = await cFetch<any>(
      `/scheduled_events?organization=${encodeURIComponent(orgUri)}&${qs}`,
    );
    collection = j?.collection || [];
  } catch {
    const j = await cFetch<any>(`/scheduled_events?user=${encodeURIComponent(userUri)}&${qs}`);
    collection = j?.collection || [];
  }
  const events = normalizeCalendlyEvents(collection);

  const r: CalendlySyncResult = {
    events: events.length,
    candidates: 0,
    created: 0,
    existing: 0,
    errors: 0,
    items: [],
  };
  const note = (line: string): void => {
    if (r.items.length < 100) r.items.push(line);
  };

  // Davetli e-postalari etkinlik basina ayri cagriyla gelir.
  const withEmails: Array<{ title: string; startMs: number; emails: string[] }> = [];
  for (const ev of events.slice(0, 100)) {
    try {
      const inv = await cFetch<any>(`${ev.uri}/invitees?count=100`);
      const emails = (inv?.collection || [])
        .filter((i: any) => !i?.status || i.status === "active")
        .map((i: any) => String(i?.email || "").toLowerCase().trim())
        .filter((e: string) => e.includes("@"));
      withEmails.push({ title: ev.title, startMs: ev.startMs, emails });
    } catch (e: any) {
      r.errors++;
      note(`HATA davetli okunamadi "${ev.title}": ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  const candidates = extractDemoCandidates(withEmails, Date.now());
  r.candidates = candidates.length;
  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
  for (const cand of candidates) {
    // HubSpot ARAMA API'sinin 4 istek/sn limiti icin fren (429 onlemi).
    await sleep(350);
    try {
      if (await findExistingDealForDomain(cand.domain, PIPELINE_ID)) {
        r.existing++;
        continue;
      }
      const when = new Date(cand.startMs).toISOString().slice(0, 16).replace("T", " ");
      if (!dry) {
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
        // Kullanici kurali: Calendly'den book edilen demo "Unassigned"a duser;
        // Scheduled'a tasima karari EKIBIN elindedir (takim ici degerlendirme
        // sonrasi elle). Toplanti gerceklesince otomasyon Meeting'e alir.
        const deal = await hs.createObject("deal", {
          dealname: cand.domain,
          pipeline: PIPELINE_ID,
          dealstage: STAGE.unassigned,
        });
        if (companyId) await hs.associateDefault("deal", String(deal.id), "company", companyId);
      }
      r.created++;
      note(`${cand.domain}: "${cand.title || "(bassiz)"}" @ ${when} UTC -> Sales deal (Unassigned)`);
    } catch (e: any) {
      r.errors++;
      note(`HATA ${cand.domain}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  return r;
}
