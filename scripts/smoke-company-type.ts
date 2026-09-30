// lib/company-type.ts saf fonksiyon testleri. Ag yok, HubSpot yok.
// Kosum: npx tsx scripts/smoke-company-type.ts
import {
  classifyCompanyType,
  VC_NAME_RE,
  VC_INDUSTRIES,
  CUSTOMER_INDUSTRIES,
  TYPE_VC,
  TYPE_CUSTOMER,
  PROP,
  normalizeTypeValue,
  DROPDOWN_OPTIONS,
} from "../lib/company-type.js";

let pass = 0;
const fails: string[] = [];
function eq(a: unknown, b: unknown, label: string): void {
  if (a === b) pass++;
  else fails.push(`${label} (beklenen ${JSON.stringify(b)}, gelen ${JSON.stringify(a)})`);
}
const vc = (n: string, i?: string) => eq(classifyCompanyType(n, i), TYPE_VC, `vc: ${n}`);
const cu = (n: string, i?: string) => eq(classifyCompanyType(n, i), TYPE_CUSTOMER, `customer: ${n}`);

// --- 1) Sabitler ---
eq(PROP, "company_type", "alan adi");
eq(TYPE_VC, "vc", "vc degeri KUCUK harf (mevcut veriyle ayni)");
eq(TYPE_CUSTOMER, "customer", "customer degeri KUCUK harf");

// --- 2) Kullanicinin saydigi terimler ---
vc("Spectrum Equity");
vc("Araya Ventures");
vc("Kennet Partners");
vc("Nina Capital");
vc("Exit Fund");
vc("Unity Investments");
vc("Side Angels");
// "holding" listede DEGIL: bu portaldaki Turk holdingleri musteri.
cu("Sayaholding");
cu("Aktif Holding");
// Gercek yatirim holdingi industry'den yakalanir:
vc("Aktif Holding", "INVESTMENT_MANAGEMENT");
vc("Bling Capital");
vc("Hiro Capital");

// --- 3) Cekim ekleri / tekil-cogul ---
vc("Prime Venture Partners");
vc("Alta Partners");
vc("Clover Fund");
vc("Evli Growth Partners");
vc("Elaia Partners");
vc("Y Innovations Investment");
vc("Frazier Investors");
vc("Seed Investing Group");
vc("Astel Funding");
vc("Anterra Asset Management");
vc("Bessemer Family Office");

// --- 4) "vc" KELIME olarak eslesir, HECE olarak ESLESMEZ ---
// Kelime siniri olmadan "Service"/"Advance" gibi kelimeler vc sayilirdi.
vc("Revo VC");
vc("Tidal VC");
vc("Owl VC");
cu("Legacy Service Group");
cu("Advance Pharma");
cu("ServiceNow");
cu("Novo Nordisk Services");

// --- 5) industry ADDAN ONCE gelir ---
// Portalda dogrulanan gercek yanlis pozitif:
cu("Freedom Bioscience Partners", "PHARMACEUTICALS");
cu("Alpha Capital Devices", "MEDICAL_DEVICES");
cu("Venture Biolabs", "BIOTECHNOLOGY");
cu("Partners Research Institute", "RESEARCH");
cu("Capital Hospital Group", "HOSPITAL_HEALTH_CARE");
// Ters yon: sektor fon diyorsa ad sade olsa da vc
vc("Windham", "VENTURE_CAPITAL_PRIVATE_EQUITY");
vc("AlphaCurrent", "INVESTMENT_BANKING");
vc("Northzone", "INVESTMENT_MANAGEMENT");
vc("Blumberg", "CAPITAL_MARKETS");
// Sektor fon VE ad VC -> vc
vc("Liss Capital Partners", "VENTURE_CAPITAL_PRIVATE_EQUITY");

// --- 6) Notr/bilinmeyen sektor -> ad kurali isler ---
vc("Great Hill Partners", "FINANCIAL_SERVICES");
vc("Delta Partners", "MANAGEMENT_CONSULTING");
vc("Silverton Partners", "");
vc("PAI Partners", undefined);
cu("Thermo Fisher Scientific", "");
cu("Reckitt", "RETAIL");
cu("Eker", undefined);

// --- 7) Gercek musteriler (VC terimi yok) ---
cu("AbbVie");
cu("IQVIA");
cu("Sudair Pharma");
cu("NNIT");
cu("Charles River Laboratories");
cu("Knight Therapeutics");
cu("Agon");
cu("Eva Pharma");
cu("Transgene");
cu("Jabil");

// --- 8) Bos/bozuk girdi -> customer (asla patlamaz) ---
cu("");
eq(classifyCompanyType(null), TYPE_CUSTOMER, "null ad -> customer");
eq(classifyCompanyType(undefined), TYPE_CUSTOMER, "undefined ad -> customer");
eq(classifyCompanyType("   "), TYPE_CUSTOMER, "bosluk ad -> customer");
eq(classifyCompanyType("Acme", null), TYPE_CUSTOMER, "null industry sorun degil");

// --- 9) Buyuk/kucuk harf ve industry normalizasyonu ---
vc("KENNET PARTNERS");
vc("kennet partners");
cu("freedom bioscience partners", "pharmaceuticals"); // kucuk harf industry
cu("Freedom Bioscience Partners", "  Pharmaceuticals  "); // bosluklu

// --- 9b) FUND_RAISING ve portfoy (2026-09 eklemeleri) ---
vc("AlchemistAccelerator", "FUND_RAISING");
vc("FjordPoint Capital", "FUND_RAISING");
// TR ve ASCII yazim
vc("Aktif Portföy");
vc("Aktif Portfoy");
vc("Quantum Portfolio Management");
vc("Portfolio Advisors");
vc("SHP Portfolio");
// Sektor kesin musteri ise portfoy adi bile ezilir
cu("Portfolio Bioscience", "PHARMACEUTICALS");
// Kelime siniri: bitisik yazim eslesmez
cu("Portfoliomatic Devices", "MEDICAL_DEVICES");

// --- 10) Regex dogrudan ---
eq(VC_NAME_RE.test("Acme Ventures"), true, "regex: Ventures");
eq(VC_NAME_RE.test("Acme Service"), false, "regex: Service eslesmez");
eq(VC_NAME_RE.test("advcapital"), false, "regex: bitisik yazim eslesmez (kelime siniri)");
eq(VC_INDUSTRIES.has("VENTURE_CAPITAL_PRIVATE_EQUITY"), true, "VC_INDUSTRIES icerir");
eq(CUSTOMER_INDUSTRIES.has("PHARMACEUTICALS"), true, "CUSTOMER_INDUSTRIES icerir");
eq(VC_INDUSTRIES.has("PHARMACEUTICALS"), false, "iki liste kesismez");

// --- 11) Yazim normalizasyonu (dropdown gecisi oncesi) ---
eq(normalizeTypeValue("vc"), TYPE_VC, "normalize: vc");
eq(normalizeTypeValue("customer"), TYPE_CUSTOMER, "normalize: customer");
// Portalda bulunan gercek kayma:
eq(normalizeTypeValue("VC"), TYPE_VC, "normalize: buyuk harf VC");
eq(normalizeTypeValue("Customer"), TYPE_CUSTOMER, "normalize: Customer");
eq(normalizeTypeValue("  vC  "), TYPE_VC, "normalize: bosluk + karisik harf");
eq(normalizeTypeValue("CUSTOMER"), TYPE_CUSTOMER, "normalize: CUSTOMER");
// Bos -> normalize isi degil (doldurucunun isi)
eq(normalizeTypeValue(""), null, "normalize: bos -> null");
eq(normalizeTypeValue(null), null, "normalize: null -> null");
eq(normalizeTypeValue("   "), null, "normalize: bosluk -> null");
// Taninmayan deger -> null (cagiran yeniden siniflandirir)
eq(normalizeTypeValue("prospect"), null, "normalize: taninmayan -> null");
eq(normalizeTypeValue("vendor"), null, "normalize: vendor -> null");

// --- 12) Dropdown secenekleri veriyle AYNI olmali ---
// Enum'a gecince tanimli secenek disindaki deger gecersiz olur; option
// value'lari mevcut kucuk harf veriyle birebir ayni olmak ZORUNDA.
eq(DROPDOWN_OPTIONS.length, 2, "iki secenek");
eq(DROPDOWN_OPTIONS[0].value, TYPE_VC, "1. secenek value = vc");
eq(DROPDOWN_OPTIONS[1].value, TYPE_CUSTOMER, "2. secenek value = customer");
eq(DROPDOWN_OPTIONS[0].label, "VC", "1. secenek etiketi VC");
eq(DROPDOWN_OPTIONS[1].label, "Customer", "2. secenek etiketi Customer");

console.log(`${pass} kontrol gecti, ${fails.length} basarisiz`);
for (const f of fails) console.error("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
