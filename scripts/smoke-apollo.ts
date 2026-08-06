// Apollo outreach senkronu duman testi (network YOK): normalizasyon + endpoint auth.
process.env.FIREFLIES_WEBHOOK_SECRET = "test-secret";
process.env.NODE_ENV = "production"; // fail-closed yollarini da test et

import { normalizeApolloContact, normalizeApolloOrganization } from "../lib/apollo.js";
import { desiredCompanyProps } from "../lib/company.js";
import { app } from "../src/index.js";

let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

// normalizeApolloContact
const n = normalizeApolloContact({
  email: "Jane.Doe@Acme.com",
  first_name: " Jane ",
  last_name: "Doe",
  title: "QA Lead",
  city: "Istanbul",
  country: "Turkey",
  phone_numbers: [{ raw_number: "+90 (555) 111 22 33", sanitized_number: "+905551112233" }],
  organization: {
    name: "Acme",
    primary_domain: "ACME.com",
    website_url: "https://www.acme.com",
    linkedin_url: "https://linkedin.com/company/acme",
    industry: "information technology & services",
    estimated_num_employees: 250,
    phone: "+90 212 000 00 00",
    city: "Ankara",
    country: "Turkey",
  },
  linkedin_url: "https://linkedin.com/in/janedoe",
  label_names: ["Pharma TR", "Q3"],
});
check("normalize email kucuk harf", n?.email === "jane.doe@acme.com");
check("normalize isim trim", n?.firstName === "Jane" && n?.lastName === "Doe");
check("normalize domain kucuk harf", n?.companyDomain === "acme.com");
check("normalize labels", JSON.stringify(n?.labels) === JSON.stringify(["Pharma TR", "Q3"]));
check("normalize telefon sanitized", n?.phone === "+905551112233");
check("normalize contact sehir/ulke", n?.city === "Istanbul" && n?.country === "Turkey");
check("normalize sirket website/linkedin",
  n?.companyWebsite === "https://www.acme.com" &&
  n?.companyLinkedinUrl === "https://linkedin.com/company/acme");
check("normalize sirket sektor/calisan",
  n?.companyIndustry === "information technology & services" && n?.companyEmployees === 250);
check("normalize sirket tel/sehir/ulke",
  n?.companyPhone === "+90 212 000 00 00" && n?.companyCity === "Ankara" && n?.companyCountry === "Turkey");
check("normalize e-postasiz -> null", normalizeApolloContact({ first_name: "X" }) === null);
check("normalize bozuk -> null", normalizeApolloContact(null) === null);

// Eksik/bozuk zenginlestirme alanlari guvenli varsayilanlara duser
const bare = normalizeApolloContact({ email: "x@y.com", organization: { estimated_num_employees: "n/a" } });
check("normalize eksik alanlar bos/null",
  bare?.phone === "" && bare?.companyWebsite === "" && bare?.companyEmployees === null);

// normalizeApolloOrganization (organizations/enrich yaniti icin)
const o = normalizeApolloOrganization({
  name: "Acme",
  primary_domain: "ACME.com",
  website_url: "https://www.acme.com",
  linkedin_url: "https://linkedin.com/company/acme",
  industry: "biotechnology",
  estimated_num_employees: 42.6,
  primary_phone: { number: "+1 555 000 11 22" },
  city: "Boston",
  country: "United States",
});
check("org normalize domain/website",
  o?.domain === "acme.com" && o?.website === "https://www.acme.com");
check("org normalize calisan yuvarlanir", o?.employees === 43);
check("org normalize primary_phone yedegi", o?.phone === "+1 555 000 11 22");
check("org normalize bozuk -> null", normalizeApolloOrganization(null) === null);

// desiredCompanyProps — HubSpot property adlarina cevirim. HUBSPOT_TOKEN bu
// testte YOK: industry eslemesi guvenle atlanmali, digerleri dolmali.
const dc = await desiredCompanyProps({
  website: "https://x.com", linkedinUrl: "https://linkedin.com/company/x",
  industry: "biotechnology", employees: 10, phone: "", city: "", country: "Türkiye",
});
check("desired: alan cevirimi",
  dc.website === "https://x.com" && dc.linkedin_company_page === "https://linkedin.com/company/x" &&
  dc.numberofemployees === "10" && dc.country === "Türkiye" && !("phone" in dc));
check("desired: token yokken industry guvenle atlanir", !("industry" in dc));

// Endpoint auth (Hono app.request — network yok)
const hint = await app.request("/api/apollo-sync");
const hintJson: any = await hint.json();
check("GET anahtarsiz -> 200 hint", hint.status === 200 && hintJson.hint !== undefined);

const bad = await app.request("/api/apollo-sync?key=WRONG", { method: "POST" });
check("POST yanlis key -> 401", bad.status === 401);

const badBearer = await app.request("/api/apollo-sync", {
  method: "GET",
  headers: { authorization: "Bearer WRONG" },
});
check("GET yanlis bearer -> 401", badBearer.status === 401);

// Dogru key ama APOLLO_API_KEY yok -> 200 + acik hata mesaji (retry firtinasi yok)
const ok = await app.request("/api/apollo-sync?key=test-secret", { method: "POST" });
const okJson: any = await ok.json();
check("POST dogru key, Apollo anahtarsiz -> 200 + hata", ok.status === 200 && okJson.ok === false && /APOLLO_API_KEY/.test(okJson.error || ""));

// /api/backfill-companies — ayni auth zinciri
const bfHint = await app.request("/api/backfill-companies");
const bfHintJson: any = await bfHint.json();
check("backfill GET anahtarsiz -> 200 hint", bfHint.status === 200 && bfHintJson.hint !== undefined);
const bfBad = await app.request("/api/backfill-companies?key=WRONG");
check("backfill yanlis key -> 401", bfBad.status === 401);
const bfNoEnv = await app.request("/api/backfill-companies?key=test-secret&dry=1");
const bfNoEnvJson: any = await bfNoEnv.json();
check("backfill dogru key, token'siz -> 200 + acik hata",
  bfNoEnv.status === 200 && bfNoEnvJson.ok === false &&
  /HUBSPOT_TOKEN|APOLLO_API_KEY/.test(bfNoEnvJson.error || ""));

console.log(fail === 0 ? "\nOK: Apollo senkron duman testi gecti" : `\nHATA: ${fail} kontrol basarisiz`);
process.exit(fail === 0 ? 0 : 1);
