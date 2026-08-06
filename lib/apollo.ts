// Apollo.io istemcisi (salt-okuma): kayitli contact listelerini ceker.
// Kullanim: outreach baslar baslamaz (contact Apollo listesine eklenince)
// HubSpot'a lead olarak dusurmek. Anahtar: APOLLO_API_KEY (.env.local / Vercel).

export class ApolloError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApolloError";
    this.status = status;
  }
}

const BASE = "https://api.apollo.io/v1";

function apiKey(): string {
  const k = process.env.APOLLO_API_KEY;
  if (!k) throw new Error("APOLLO_API_KEY tanimli degil");
  return k;
}

async function apolloFetch<T = any>(
  pathname: string,
  body?: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const res = await fetch(`${BASE}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey(),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs || 20000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApolloError(
      `Apollo ${res.status} POST ${pathname}: ${text.slice(0, 300)}`,
      res.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApolloError(`Apollo JSON degil: ${text.slice(0, 200)}`);
  }
}

/** Normalize edilmis Apollo organizasyonu — HubSpot company alanlarina kaynak. */
export interface ApolloCompanyInfo {
  name: string;
  domain: string;
  website: string;
  linkedinUrl: string;
  /** Apollo sektor metni — HubSpot enum'una eslemeyi company.ts yapar. */
  industry: string;
  employees: number | null;
  phone: string;
  city: string;
  country: string;
}

export function normalizeApolloOrganization(org: any): ApolloCompanyInfo | null {
  if (!org || typeof org !== "object") return null;
  const employees = Number(org?.estimated_num_employees);
  return {
    name: String(org?.name || "").trim(),
    domain: String(org?.primary_domain || org?.domain || "").toLowerCase().trim(),
    website: String(org?.website_url || "").trim(),
    linkedinUrl: String(org?.linkedin_url || "").trim(),
    industry: String(org?.industry || "").trim(),
    employees: isFinite(employees) && employees > 0 ? Math.round(employees) : null,
    phone: String(org?.phone || org?.primary_phone?.number || org?.sanitized_phone || "").trim(),
    city: String(org?.city || "").trim(),
    country: String(org?.country || "").trim(),
  };
}

/**
 * Organization Enrichment: domain'den sirket profili ceker. Toplanti
 * pipeline'inin yarattigi sirketlerin (Apollo listesinde contact'i olmayanlar
 * dahil) HubSpot alanlarini doldurmak icin. Taninmayan domain -> null.
 */
export async function enrichOrganization(domain: string): Promise<ApolloCompanyInfo | null> {
  const d = String(domain || "").toLowerCase().trim();
  if (!d) return null;
  let json: any;
  try {
    // Webhook'un 60s butcesini korumak icin dar zaman siniri.
    json = await apolloFetch<any>(
      `/organizations/enrich?domain=${encodeURIComponent(d)}`,
      undefined,
      { timeoutMs: 10000 },
    );
  } catch (e: any) {
    if (e instanceof ApolloError && e.status === 404) return null; // Apollo domain'i tanimiyor
    throw e;
  }
  return normalizeApolloOrganization(json?.organization);
}

/** Normalize edilmis Apollo contact — HubSpot'a yazilacak alanlar. */
export interface ApolloContact {
  email: string;
  firstName: string;
  lastName: string;
  title: string;
  /** Ilk telefon (sanitized) — kayitli contact'ta genelde hazir gelir. */
  phone: string;
  city: string;
  country: string;
  linkedinUrl: string;
  companyName: string;
  companyDomain: string;
  companyWebsite: string;
  /** Sirketin LinkedIn sayfasi (organization.linkedin_url). */
  companyLinkedinUrl: string;
  /** Apollo sektor metni — HubSpot enum'una eslemeyi outreach yapar. */
  companyIndustry: string;
  companyEmployees: number | null;
  companyPhone: string;
  companyCity: string;
  companyCountry: string;
  /** Apollo'daki liste (label) adlari. */
  labels: string[];
}

export function normalizeApolloContact(raw: any): ApolloContact | null {
  const email = String(raw?.email || "").toLowerCase().trim();
  if (!email || !email.includes("@")) return null; // e-postasiz lead CRM'e giremez
  const org = normalizeApolloOrganization(raw?.organization || raw?.account || {})!;
  const firstPhone = Array.isArray(raw?.phone_numbers) && raw.phone_numbers.length
    ? raw.phone_numbers[0]?.sanitized_number || raw.phone_numbers[0]?.raw_number
    : raw?.sanitized_phone;
  return {
    email,
    firstName: String(raw?.first_name || "").trim(),
    lastName: String(raw?.last_name || "").trim(),
    title: String(raw?.title || "").trim(),
    phone: String(firstPhone || "").trim(),
    city: String(raw?.city || "").trim(),
    country: String(raw?.country || "").trim(),
    linkedinUrl: String(raw?.linkedin_url || "").trim(),
    companyName: org.name,
    companyDomain: org.domain,
    companyWebsite: org.website,
    companyLinkedinUrl: org.linkedinUrl,
    companyIndustry: org.industry,
    companyEmployees: org.employees,
    companyPhone: org.phone,
    companyCity: org.city,
    companyCountry: org.country,
    labels: Array.isArray(raw?.label_names) ? raw.label_names.map(String) : [],
  };
}

/**
 * Verilen listedeki (label) kayitli contact'lari sayfalayarak ceker.
 * labelNames bos -> TUM kayitli contact'lar (dikkatli kullan).
 */
export async function fetchApolloContacts(opts: {
  labelNames?: string[];
  max?: number;
} = {}): Promise<ApolloContact[]> {
  const max = opts.max ?? 500;
  const out: ApolloContact[] = [];
  const PER_PAGE = 100;
  for (let page = 1; out.length < max; page++) {
    const body: Record<string, unknown> = {
      page,
      per_page: Math.min(PER_PAGE, max - out.length),
      sort_by_field: "contact_created_at",
      sort_ascending: false,
    };
    if (opts.labelNames && opts.labelNames.length) body.label_names = opts.labelNames;
    const json = await apolloFetch<any>("/contacts/search", body);
    const batch = (json?.contacts || [])
      .map(normalizeApolloContact)
      .filter(Boolean) as ApolloContact[];
    out.push(...batch);
    const totalPages = Number(json?.pagination?.total_pages || 1);
    if (page >= totalPages || !(json?.contacts || []).length) break;
  }
  return out;
}

/**
 * People Match: e-postadan kisi profili ceker (HubSpot'a gelen contact'i
 * zenginlestirmek icin). Bulunamazsa null. NOT: eslesme Apollo kredisi
 * tuketir — cagiran taraf ayni contact'i tekrar sormamaktan sorumludur
 * (apollo_enriched_at damgasi).
 */
export async function matchPerson(email: string): Promise<ApolloContact | null> {
  const e = String(email || "").toLowerCase().trim();
  if (!e || !e.includes("@")) return null;
  let json: any;
  try {
    json = await apolloFetch<any>("/people/match", { email: e }, { timeoutMs: 12000 });
  } catch (err: any) {
    if (err instanceof ApolloError && err.status === 404) return null;
    throw err;
  }
  if (!json?.person) return null;
  // person.email gizlenmis olabilir -> sorgulanan e-postayi kullan
  return normalizeApolloContact({ ...json.person, email: json.person.email || e });
}
