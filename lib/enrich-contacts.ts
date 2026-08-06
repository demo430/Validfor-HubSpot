// HubSpot'a GELEN contact'lari Apollo People Match ile zenginlestirir.
// YON DEGISIKLIGI (kullanici karari): eski "Apollo listesini HubSpot'a ice
// aktar" senkronu KALDIRILDI; artik kaynak HubSpot'tur (toplanti, Calendly,
// elle giris — fark etmez), Apollo yalnizca zenginlestirme sorgusudur.
//
// Kurallar:
//  - apollo_enriched_at damgasi: her contact Apollo'ya EN FAZLA BIR KEZ
//    sorulur (people/match kredi tuketir); sonuc ne olursa olsun damgalanir.
//  - Kredi korumasi: cekirdek alanlari (ad+soyad+unvan+LinkedIn) ZATEN dolu
//    contact Apollo'ya hic sorulmadan "complete" damgalanir.
//  - Yalniz-bossa-yaz; ic (validfor.com) hesaplar "skipped" damgalanir.
//  - Sirket katmani: kisi eslesirse AYNI eslesmenin org verisiyle sirket
//    bul-olustur + iliskilendir + bos alanlarini doldur (ekstra Apollo
//    cagrisi YOK).
import * as hs from "./hubspot.js";
import { matchPerson } from "./apollo.js";
import { desiredCompanyProps, COMPANY_ENRICH_PROPS } from "./company.js";
import { emailDomain, isInternalEmail, FREE_EMAIL_DOMAINS } from "./upsert.js";

export const ENRICH_MARKER = "apollo_enriched_at";
const CONTACT_PROPS = [
  "email", "firstname", "lastname", "jobtitle", "phone", "city", "country",
  "hs_linkedin_url", "company", ENRICH_MARKER,
];

// SAF: cekirdek kimlik alanlari doluysa Apollo sorgusuna gerek yok.
export function isCoreComplete(p: Record<string, unknown>): boolean {
  return ["firstname", "lastname", "jobtitle", "hs_linkedin_url"].every((k) =>
    String((p as any)?.[k] || "").trim(),
  );
}

export interface ContactEnrichResult {
  scanned: number;
  enriched: number;
  alreadyComplete: number;
  notFound: number;
  skipped: number; // ic hesap / e-postasiz
  errors: number;
  /** Damgasiz contact kalmadiysa true. */
  done: boolean;
  items: string[];
}

export async function enrichIncomingContacts(
  opts: { max?: number; dry?: boolean } = {},
): Promise<ContactEnrichResult> {
  if (!process.env.APOLLO_API_KEY) throw new Error("APOLLO_API_KEY tanimli degil");
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  const max = Math.min(Math.max(opts.max ?? 25, 1), 50);
  const dry = !!opts.dry;
  const r: ContactEnrichResult = {
    scanned: 0, enriched: 0, alreadyComplete: 0, notFound: 0,
    skipped: 0, errors: 0, done: false, items: [],
  };
  const note = (s: string): void => {
    if (r.items.length < 60) r.items.push(s);
  };

  // Damgasiz contact'lar, en yeni once (yeni gelenler en hizli zenginlessin).
  const search = await hs.hsFetch<{ total?: number; results?: any[] }>(
    "/crm/v3/objects/contacts/search",
    {
      method: "POST",
      body: {
        filterGroups: [
          { filters: [{ propertyName: ENRICH_MARKER, operator: "NOT_HAS_PROPERTY" }] },
        ],
        properties: CONTACT_PROPS,
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        limit: max,
      },
    },
  );
  const contacts = search.results || [];
  r.done = (search.total ?? contacts.length) <= contacts.length;

  for (const c of contacts) {
    r.scanned++;
    const cid = String(c.id);
    const p = c.properties || {};
    const email = String(p.email || "").toLowerCase().trim();
    try {
      if (!email || isInternalEmail(email)) {
        r.skipped++;
        if (!dry) await hs.updateObject("contact", cid, { [ENRICH_MARKER]: "skipped" });
        continue;
      }
      if (isCoreComplete(p)) {
        // Kredi korumasi: zaten dolu -> Apollo'ya sorma.
        r.alreadyComplete++;
        if (!dry) await hs.updateObject("contact", cid, { [ENRICH_MARKER]: "complete" });
        continue;
      }
      if (dry) {
        note(`DRY ${email}: Apollo'ya sorulacak`);
        continue;
      }

      const person = await matchPerson(email);
      if (!person) {
        r.notFound++;
        await hs.updateObject("contact", cid, {
          [ENRICH_MARKER]: `notfound ${new Date().toISOString().slice(0, 10)}`,
        });
        continue;
      }

      const patch: Record<string, string> = {
        [ENRICH_MARKER]: new Date().toISOString(),
      };
      const set = (k: string, v: string): void => {
        if (v && !String(p[k] || "").trim()) patch[k] = v;
      };
      set("firstname", person.firstName);
      set("lastname", person.lastName);
      set("jobtitle", person.title);
      set("phone", person.phone);
      set("city", person.city);
      set("country", person.country);
      set("hs_linkedin_url", person.linkedinUrl);
      set("company", person.companyName);
      await hs.updateObject("contact", cid, patch);

      // Sirket katmani — ayni eslesmenin org verisi (ekstra Apollo cagrisi yok).
      const domain =
        person.companyDomain ||
        (FREE_EMAIL_DOMAINS.has(emailDomain(email)) ? "" : emailDomain(email));
      if (domain) {
        const comp = await hs.searchByProperty(
          "company", "domain", "EQ", domain, ["name", ...COMPANY_ENRICH_PROPS],
        );
        let compId: string = comp?.id || "";
        const compProps: Record<string, string> = comp?.properties || {};
        if (!compId) {
          const created = await hs.createObject("company", {
            name: person.companyName || domain,
            domain,
          });
          compId = String(created.id);
        }
        const desired = await desiredCompanyProps({
          website: person.companyWebsite,
          linkedinUrl: person.companyLinkedinUrl,
          industry: person.companyIndustry,
          employees: person.companyEmployees,
          phone: person.companyPhone,
          city: person.companyCity,
          country: person.companyCountry,
        });
        const cpatch: Record<string, string> = {};
        for (const [k, v] of Object.entries(desired)) {
          if (!String(compProps[k] || "").trim()) cpatch[k] = v;
        }
        if (Object.keys(cpatch).length) await hs.updateObject("company", compId, cpatch);
        await hs.associateDefault("contact", cid, "company", compId);
      }

      r.enriched++;
      const got = Object.keys(patch).filter((k) => k !== ENRICH_MARKER);
      note(`${email}: ${got.length ? got.join(",") : "(yeni alan yok)"}`);
    } catch (e: any) {
      r.errors++;
      note(`HATA ${email}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  return r;
}
