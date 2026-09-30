// Company Type doldurucu: sirket kaydina "vc" ya da "customer" yazar.
//
// Kullanici kurali (2026-09): "Icinde equity, venture, partner gibi VC
// terimleri varsa vc, geri kalanlar customer."
//
// Mevcut veri kucuk harf kullaniyor (portalda 5.724 "vc", 2.840 "customer"),
// o duzene uyulur. Alan SERBEST METIN (enum degil) — yazim serbest, bu yuzden
// sabitler tek yerde tutulur.
//
// --- NEDEN yalniz ada bakmak yetmez ---
// "Partners" kelimesi fonlarda da hizmet sirketlerinde de geciyor. Portalda
// dogrulanan yanlis pozitifler: "Freedom Bioscience Partners"
// (industry=PHARMACEUTICALS), "Legacy Service Partners", "Harmanci & Partners"
// (hukuk/danismanlik). Bu yuzden `industry` alani ADDAN ONCE gelir: ilac/
// tibbi cihaz/arastirma gibi bir sektor yaziyorsa ad ne olursa olsun customer.
// industry bos olan 6.465 kayitta ad kurali tek basina calisir.
import * as hs from "./hubspot.js";

export const TYPE_VC = "vc";
export const TYPE_CUSTOMER = "customer";
export const PROP = "company_type";

/** Sektoru kesin FON olanlar -> ad kuralina bakilmaz. */
export const VC_INDUSTRIES = new Set([
  "VENTURE_CAPITAL_PRIVATE_EQUITY",
  "INVESTMENT_MANAGEMENT",
  "INVESTMENT_BANKING",
  "CAPITAL_MARKETS",
  // FUND_RAISING kullanici istegiyle eklendi (hizlandirici/fon kayitlari
  // burada). DIKKAT: bu sektor TEMIZ bir sinyal DEGIL — bagis toplayan hayir
  // kurumlari da buraya dusuyor (portalda "Jewish Federation of Greater
  // MetroWest NJ"). O kayit elle customer'a sabitlendi; dolu alan asla
  // ezilmedigi icin orada kalir. Benzer bir kayit gorursen aynisini yap.
  "FUND_RAISING",
]);

/** Sektoru kesin MUSTERI olanlar -> adinda "Partners" gecse bile customer. */
export const CUSTOMER_INDUSTRIES = new Set([
  "PHARMACEUTICALS",
  "MEDICAL_DEVICES",
  "BIOTECHNOLOGY",
  "RESEARCH",
  "HOSPITAL_HEALTH_CARE",
  "MEDICAL_PRACTICE",
  "CHEMICALS",
  "VETERINARY",
  "COSMETICS",
  "FOOD_PRODUCTION",
  "FOOD_BEVERAGES",
]);

// Ada bakan VC terimleri. Kelime siniri SART:
//   - "\bvc\b" olmadan "Service", "Advance" gibi kelimeler eslesir
//   - "invest\w*" investment/investors/investing hepsini kapsar
// Mevcut otomasyonun VC tespitiyle (lib/gcal.ts VC_KEYWORDS) uyumlu; kullanici
// istegi uzerine "partner" de eklendi.
//
// "holding" BILINCLI olarak YOK: kullanici saymadi, gcal'daki ad kuralinda da
// yok ve bu portaldaki Turk holdingleri musteri (orn. "Sayaholding / Aktif
// Portfoy" Sales kartidir). Gercek yatirim holdingleri industry alanindan
// (INVESTMENT_MANAGEMENT) yakalanir.
// "portfolio" / "portfoy" / "portföy" (TR) kullanici istegiyle eklendi:
// portfoy yonetim sirketleri yatirimci tarafi (orn. "Aktif Portföy",
// "Quantum Portfolio Management"). Turkce "ö" ve ASCII "o" ikisi de kabul.
export const VC_NAME_RE =
  /\b(?:vc|ventures?|capital|equity|partners?|funds?|funding|invest\w*|angels?|portf(?:olio|[oö]y)|asset management|family office)\b/i;

export type CompanyType = typeof TYPE_VC | typeof TYPE_CUSTOMER;

/**
 * SAF: bir sirket kaydini siniflandirir. Oncelik sirasi:
 *   1) industry kesin fon     -> vc
 *   2) industry kesin musteri -> customer   (ad kuralini EZER)
 *   3) adinda VC terimi       -> vc
 *   4) aksi halde             -> customer
 */
export function classifyCompanyType(
  name: string | null | undefined,
  industry?: string | null,
): CompanyType {
  const ind = String(industry || "")
    .trim()
    .toUpperCase();
  if (VC_INDUSTRIES.has(ind)) return TYPE_VC;
  if (CUSTOMER_INDUSTRIES.has(ind)) return TYPE_CUSTOMER;
  const n = String(name || "").trim();
  if (n && VC_NAME_RE.test(n)) return TYPE_VC;
  return TYPE_CUSTOMER;
}

export interface CompanyTypeResult {
  scanned: number;
  vc: number;
  customer: number;
  written: number; // dry'da: yazilacak
  errors: number;
  /** false ise butce doldu — ucu tekrar cagir (kaldigi yerden devam eder). */
  done: boolean;
  /** Ilk 50 karar ornegi: "Acme Partners [PHARMACEUTICALS] -> customer" */
  samples: string[];
}

const BATCH = 100;

/**
 * company_type BOS olan sirketleri tarar ve doldurur. Dolu olanlara ASLA
 * dokunmaz (bos-alan kurali) — insanin ya da onceki kosumun yazdigi deger
 * korunur.
 *
 * Iki fazli: once TUM sayfalar okunur, sonra yazilir (bkz. faz 1 notu —
 * yazarken okumak arama indeksi gecikmesi yuzunden sonsuz donguye girer).
 * Butce dolarsa done:false doner; uc tekrar cagrilarak bitirilir.
 */
export async function backfillCompanyTypes(
  opts: { dry?: boolean; max?: number; budgetMs?: number } = {},
): Promise<CompanyTypeResult> {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  const dry = !!opts.dry;
  const max = Math.min(Math.max(opts.max ?? 20000, 1), 50000);
  const budgetMs = Math.min(Math.max(opts.budgetMs ?? 45000, 5000), 300000);
  const started = Date.now();
  const r: CompanyTypeResult = {
    scanned: 0,
    vc: 0,
    customer: 0,
    written: 0,
    errors: 0,
    done: true,
    samples: [],
  };

  // --- FAZ 1: OKU (yazmadan) ---
  // DIKKAT: Once tum sayfalar toplanir, SONRA yazilir. Yazarken okumak
  // CALISMAZ: HubSpot arama indeksi birkac saniye geride oldugu icin yeni
  // yazilan kayitlar hala "bos" gorunur ve ayni kayit tekrar tekrar islenir
  // (2026-09'da olculdu: 9.755 kayitlik kume icin scanned=106.500, hic
  // bitmedi). Ayni tuzak lib/owners.ts icinde de var, cozumu ayni.
  // Okuma mutasyon yapmadigi icin sayfa imleci (after) bu fazda guvenli.
  const rows: { id: string; name?: string; industry?: string }[] = [];
  let after: string | undefined;
  for (let page = 0; page < 400; page++) {
    if (Date.now() - started > budgetMs) {
      r.done = false;
      break;
    }
    const json = await hs.hsFetch<{ results?: any[]; paging?: any }>(
      "/crm/v3/objects/companies/search",
      {
        method: "POST",
        body: {
          filterGroups: [
            { filters: [{ propertyName: PROP, operator: "NOT_HAS_PROPERTY" }] },
          ],
          properties: ["name", "domain", "industry"],
          limit: BATCH,
          ...(after ? { after } : {}),
        },
      },
    );
    for (const c of json.results || []) {
      const p = c.properties || {};
      rows.push({ id: String(c.id), name: p.name, industry: p.industry });
      if (rows.length >= max) break;
    }
    after = json.paging?.next?.after;
    if (!after || rows.length >= max) break;
  }

  // --- FAZ 2: SINIFLANDIR + YAZ ---
  const inputs: { id: string; properties: Record<string, string> }[] = [];
  for (const row of rows) {
    const t = classifyCompanyType(row.name, row.industry);
    r.scanned++;
    if (t === TYPE_VC) r.vc++;
    else r.customer++;
    if (r.samples.length < 50) {
      const label = String(row.name || row.id).slice(0, 44);
      r.samples.push(`${label} [${row.industry || "-"}] -> ${t}`);
    }
    inputs.push({ id: row.id, properties: { [PROP]: t } });
  }

  if (dry) return r; // onizleme: hicbir sey yazilmaz, tum karar dagilimi doner

  for (let i = 0; i < inputs.length; i += BATCH) {
    const part = inputs.slice(i, i + BATCH);
    try {
      await hs.hsFetch("/crm/v3/objects/companies/batch/update", {
        method: "POST",
        body: { inputs: part },
      });
      r.written += part.length;
    } catch (e: any) {
      r.errors++;
      console.error(
        "[company-type] batch yazilamadi:",
        String(e?.message || e).slice(0, 300),
      );
    }
  }
  return r;
}
