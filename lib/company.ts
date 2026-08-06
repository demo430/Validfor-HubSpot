// Sirket zenginlestirme — Apollo verisinden HubSpot company alanlari.
// Iki tuketici var: (1) Apollo outreach senkronu (contact'in gomulu org'u),
// (2) toplanti pipeline'i (organizations/enrich ile domain'den). Her yerde
// bos-alan kurali: insanin girdigi deger asla ezilmez; sirket ADI'na dokunulmaz.
import * as hs from "./hubspot.js";
import { normKey } from "./vcfields.js";
import { enrichOrganization } from "./apollo.js";

export const COMPANY_ENRICH_PROPS = [
  "website", "linkedin_company_page", "industry",
  "numberofemployees", "phone", "city", "country",
];

// HubSpot'un standart company.industry alani cogu portalda ENUM'dur: Apollo'nun
// serbest metnini ("information technology & services") dogrudan yazmak PATCH'i
// 400 ile dusurur. Secenekler canlidan bir kez cekilir (onbellekli), normalize
// eslesme bulunursa ic DEGER yazilir; bulunamazsa alan atlanir. Alan enum
// degilse (portalda ozellestirilmisse) metin aynen gecer.
let industryDefCache:
  | Promise<{ isEnum: boolean; options: Array<{ label: string; value: string }> } | null>
  | null = null;
function industryDef() {
  if (!industryDefCache) {
    industryDefCache = hs
      .getProperties("companies")
      .then((props) => {
        const p = (props || []).find((q: any) => q?.name === "industry");
        if (!p) return null;
        return {
          isEnum: String(p.type) === "enumeration",
          options: Array.isArray(p.options)
            ? p.options.map((o: any) => ({
                label: String(o?.label ?? ""),
                value: String(o?.value ?? ""),
              }))
            : [],
        };
      })
      .catch((e) => {
        industryDefCache = null; // sonraki kosum tekrar denesin
        throw e;
      });
  }
  return industryDefCache;
}
export async function mapIndustry(raw: string): Promise<string> {
  if (!raw) return "";
  const def = await industryDef().catch(() => null);
  if (!def) return "";
  if (!def.isEnum) return raw;
  const want = normKey(raw);
  const opt = def.options.find(
    (o) => normKey(o.value) === want || normKey(o.label) === want,
  );
  return opt?.value || "";
}

export interface CompanyEnrichInput {
  website: string;
  linkedinUrl: string;
  industry: string;
  employees: number | null;
  phone: string;
  city: string;
  country: string;
}

// Zenginlestirme girdisini HubSpot property adlarina cevirir (ad HARIC — sirket
// adi asla degistirilmez). industry guvenli enum eslemesinden gecer.
export async function desiredCompanyProps(
  info: CompanyEnrichInput,
): Promise<Record<string, string>> {
  const d: Record<string, string> = {};
  if (info.website) d.website = info.website;
  if (info.linkedinUrl) d.linkedin_company_page = info.linkedinUrl;
  if (info.employees != null) d.numberofemployees = String(info.employees);
  if (info.phone) d.phone = info.phone;
  if (info.city) d.city = info.city;
  if (info.country) d.country = info.country;
  const industry = await mapIndustry(info.industry);
  if (industry) d.industry = industry;
  return d;
}

// Apollo'yu arayip mevcut degerlere gore yazilacak patch'i hesaplar (YAZMAZ —
// backfill'in --dry modu da bunu kullanir). Doner: patch (bos olabilir);
// Apollo domain'i tanimiyorsa null.
export async function computeCompanyEnrichPatch(
  domain: string,
  current: Record<string, string>,
): Promise<Record<string, string> | null> {
  const info = await enrichOrganization(domain);
  if (!info) return null;
  const desired = await desiredCompanyProps(info);
  const patch: Record<string, string> = {};
  for (const [k, v] of Object.entries(desired)) {
    if (!current[k]) patch[k] = v;
  }
  return patch;
}

// Toplanti pipeline'i icin: var olan HubSpot sirketinin BOS alanlarini Apollo
// organizations/enrich ile tamamlar. APOLLO_API_KEY yoksa sessizce atlar;
// tum alanlar doluysa Apollo'yu hic aramaz (webhook basina en fazla 1 GET).
export async function enrichCompanyFromApollo(
  companyId: string,
  domain: string,
): Promise<void> {
  if (!process.env.APOLLO_API_KEY) return;
  const live = await hs.getObject("company", companyId, COMPANY_ENRICH_PROPS);
  const current: Record<string, string> = {};
  let anyEmpty = false;
  for (const k of COMPANY_ENRICH_PROPS) {
    current[k] = String(live?.properties?.[k] || "").trim();
    if (!current[k]) anyEmpty = true;
  }
  if (!anyEmpty) return;
  const patch = await computeCompanyEnrichPatch(domain, current);
  if (patch && Object.keys(patch).length) {
    await hs.updateObject("company", companyId, patch);
  }
}
