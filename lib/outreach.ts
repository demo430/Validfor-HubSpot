// Outreach girisi: Apollo listesindeki contact'lar -> HubSpot lead.
// Kurallar meeting akisiyla ayni: e-posta bazli find-or-create (mukerrersiz),
// domain -> sirket esleme, var olan kayitta YALNIZCA BOS alanlar doldurulur.
// lifecyclestage=lead yalnizca YENI olusturulan contact'a yazilir (var olan
// kaydin yasam dongusu asla degistirilmez).
import * as hs from "./hubspot.js";
import { emailDomain, isInternalEmail, FREE_EMAIL_DOMAINS } from "./upsert.js";
import { desiredCompanyProps, COMPANY_ENRICH_PROPS } from "./company.js";
import type { ApolloContact } from "./apollo.js";

const CONTACT_PROPS = [
  "email", "firstname", "lastname", "jobtitle", "company",
  "phone", "city", "country",
  "lifecyclestage", "outreach_source", "apollo_list", "hs_linkedin_url",
];
const COMPANY_PROPS = ["name", "domain", ...COMPANY_ENRICH_PROPS];

export interface OutreachSyncResult {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number; // ic/gecersiz e-posta
  errors: Array<{ email: string; error: string }>;
}

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

export async function syncOutreachContacts(
  contacts: ApolloContact[],
): Promise<OutreachSyncResult> {
  const result: OutreachSyncResult = {
    scanned: contacts.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: [],
  };

  // Ayni domain icin sirketi bir kez coz (tekrar tekrar arama olmasin).
  const companyCache = new Map<string, string>(); // domain -> companyId

  const resolveCompany = async (c: ApolloContact): Promise<string> => {
    const domain =
      c.companyDomain ||
      (FREE_EMAIL_DOMAINS.has(emailDomain(c.email)) ? "" : emailDomain(c.email));
    if (!domain) return "";
    if (companyCache.has(domain)) return companyCache.get(domain)!;

    // Apollo'nun org verisiyle sirket zenginlestirme (ad haric — var olan
    // sirketin adi asla degistirilmez; yeni kayitta ad ayrica verilir).
    const desired = await desiredCompanyProps({
      website: c.companyWebsite,
      linkedinUrl: c.companyLinkedinUrl,
      industry: c.companyIndustry,
      employees: c.companyEmployees,
      phone: c.companyPhone,
      city: c.companyCity,
      country: c.companyCountry,
    });

    const found = await hs.searchByProperty("company", "domain", "EQ", domain, COMPANY_PROPS);
    let id: string = found?.id || "";
    if (!id) {
      const created = await hs.createObject("company", {
        name: c.companyName || domain,
        domain,
        ...desired,
      });
      id = String(created.id);
    } else {
      // Var olan sirkette YALNIZCA BOS alanlar dolar (insan verisi ezilmez).
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(desired)) {
        if (!String(found.properties?.[k] || "").trim()) patch[k] = v;
      }
      if (Object.keys(patch).length) await hs.updateObject("company", id, patch);
    }
    companyCache.set(domain, id);
    return id;
  };

  await mapChunked(contacts, 4, async (c) => {
    try {
      if (isInternalEmail(c.email)) {
        result.skipped++;
        return;
      }
      const desired: Record<string, string> = { outreach_source: "apollo" };
      if (c.firstName) desired.firstname = c.firstName;
      if (c.lastName) desired.lastname = c.lastName;
      if (c.title) desired.jobtitle = c.title;
      if (c.companyName) desired.company = c.companyName;
      if (c.phone) desired.phone = c.phone;
      if (c.city) desired.city = c.city;
      if (c.country) desired.country = c.country;
      if (c.linkedinUrl) desired.hs_linkedin_url = c.linkedinUrl;
      if (c.labels.length) desired.apollo_list = c.labels.join(";");

      const companyId = await resolveCompany(c);

      const found = await hs.searchByProperty(
        "contact", "email", "EQ", c.email, CONTACT_PROPS,
      );
      let cid: string = found?.id || "";
      if (!cid) {
        try {
          const created = await hs.createObject("contact", {
            email: c.email,
            lifecyclestage: "lead", // yalnizca yeni kayitta
            ...desired,
          });
          cid = String(created.id);
          result.created++;
        } catch (e: any) {
          const m = /Existing ID:\s*(\d+)/i.exec(
            String(e?.body?.message || e?.message || ""),
          );
          if (e?.status === 409 && m) {
            cid = m[1];
            result.unchanged++;
          } else throw e;
        }
      } else {
        const patch: Record<string, string> = {};
        for (const [k, v] of Object.entries(desired)) {
          if (!String(found.properties?.[k] || "").trim()) patch[k] = v;
        }
        if (Object.keys(patch).length) {
          await hs.updateObject("contact", cid, patch);
          result.updated++;
        } else {
          result.unchanged++;
        }
      }
      if (companyId) await hs.associateDefault("contact", cid, "company", companyId);
    } catch (e: any) {
      result.errors.push({ email: c.email, error: String(e?.message || e).slice(0, 200) });
    }
  });

  return result;
}
