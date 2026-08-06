// Geriye donuk sirket doldurma cekirdegi — hem CLI script'i
// (scripts/backfill-companies.ts) hem /api/backfill-companies endpoint'i
// kullanir. Kurallar canli akisla ayni: yalniz BOS alan dolar, sirket ADI'na
// dokunulmaz, industry HubSpot enum'una guvenli eslenir (lib/company.ts).
import * as hs from "./hubspot.js";
import { COMPANY_ENRICH_PROPS, computeCompanyEnrichPatch } from "./company.js";
import { isCompanyDomain } from "./upsert.js";

// Sirket basina Apollo'ya EN FAZLA BIR KEZ sorulur (kredi korumasi — contact
// tarafindaki apollo_enriched_at ile ayni desen). Bu damga OLMADAN, Apollo'nun
// veri bulamadigi sirketler HER partide yeniden sorgulanip krediyi tuketiyordu
// (olculdu: 40 sorguda 2 dolum). Degerler: ISO tarih | "notfound <tarih>".
export const COMPANY_MARKER = "apollo_enriched_at";

export interface BackfillOpts {
  /** Apollo'ya sorulacak en fazla sirket (parti boyutu). */
  maxEnrich?: number;
  /** true: yazma, sadece ne dolacagini raporla. */
  dry?: boolean;
  /** Zaman butcesi (ms) — Vercel'in 60s fonksiyonuna sigmak icin. */
  budgetMs?: number;
  /** items listesine yazilacak en fazla satir. */
  itemLimit?: number;
}

export interface BackfillResult {
  scanned: number; //      bakilan sirket
  noDomain: number; //     domain'siz -> Apollo sorgusu imkansiz
  freeDomain: number; //   gmail vb. -> sirket domaini degil
  alreadyFull: number; //  tum alanlar zaten dolu
  notFound: number; //     Apollo domain'i tanimiyor
  nothingNew: number; //   Apollo tanidi ama bos alanlara katacagi yeni deger yok
  filled: number; //       yazilan (dry'da: yazilacak) sirket
  errors: number;
  /** true: tum sirketler tarandi. false: parti/zaman sinirina takildi — tekrar cagir. */
  done: boolean;
  /** Dolan/dolacak kayitlar: "Ad (domain): alan1, alan2" (+ HATA satirlari). */
  items: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function backfillCompanies(opts: BackfillOpts = {}): Promise<BackfillResult> {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  if (!process.env.APOLLO_API_KEY) throw new Error("APOLLO_API_KEY tanimli degil");
  const maxEnrich = opts.maxEnrich ?? 40;
  const dry = !!opts.dry;
  const budgetMs = opts.budgetMs ?? Infinity;
  const itemLimit = opts.itemLimit ?? 100;
  const t0 = Date.now();

  const PROPS = ["name", "domain", COMPANY_MARKER, ...COMPANY_ENRICH_PROPS];
  const r: BackfillResult = {
    scanned: 0, noDomain: 0, freeDomain: 0, alreadyFull: 0,
    notFound: 0, nothingNew: 0, filled: 0, errors: 0,
    done: false, items: [],
  };
  const note = (line: string): void => {
    if (r.items.length < itemLimit) r.items.push(line);
  };

  let attempts = 0; // Apollo'ya sorulan sirket sayisi (yavas olan kisim)
  const outOfBudget = (): boolean =>
    attempts >= maxEnrich || Date.now() - t0 > budgetMs;

  let after: string | undefined;
  for (;;) {
    if (outOfBudget()) return r; // done=false: kalan olabilir, tekrar cagrilmali
    const qs =
      `?limit=100&properties=${PROPS.join(",")}` +
      (after ? `&after=${encodeURIComponent(after)}` : "");
    const page = await hs.hsFetch<{ results?: any[]; paging?: any }>(
      `/crm/v3/objects/companies${qs}`,
    );
    for (const comp of page.results || []) {
      if (outOfBudget()) return r;
      r.scanned++;
      const props = comp.properties || {};
      const name = String(props.name || "").trim() || "(adsiz)";
      const domain = String(props.domain || "").toLowerCase().trim();
      if (!domain) {
        r.noDomain++;
        continue;
      }
      if (!isCompanyDomain(domain)) {
        r.freeDomain++;
        continue;
      }
      // Daha once Apollo'ya sorulmus (dolmus ya da bulunamamis) -> bir daha sorma.
      if (String(props[COMPANY_MARKER] || "").trim()) {
        r.alreadyFull++;
        continue;
      }
      const current: Record<string, string> = {};
      let anyEmpty = false;
      for (const k of COMPANY_ENRICH_PROPS) {
        current[k] = String(props[k] || "").trim();
        if (!current[k]) anyEmpty = true;
      }
      if (!anyEmpty) {
        r.alreadyFull++;
        continue;
      }
      attempts++;
      try {
        const patch = await computeCompanyEnrichPatch(domain, current);
        const stamp = new Date().toISOString();
        if (patch === null) {
          r.notFound++;
          // Apollo domain'i tanimiyor: damgala ki bir daha sorulmasin.
          if (!dry) await hs.updateObject("company", comp.id, {
            [COMPANY_MARKER]: `notfound ${stamp.slice(0, 10)}`,
          });
        } else if (!Object.keys(patch).length) {
          r.nothingNew++;
          if (!dry) await hs.updateObject("company", comp.id, { [COMPANY_MARKER]: stamp });
        } else {
          if (!dry) await hs.updateObject("company", comp.id, { ...patch, [COMPANY_MARKER]: stamp });
          r.filled++;
          note(`${name} (${domain}): ${Object.keys(patch).join(", ")}`);
        }
        await sleep(250); // Apollo rate limitine nazik davran
      } catch (e: any) {
        r.errors++;
        note(`HATA ${name} (${domain}): ${String(e?.message || e).slice(0, 160)}`);
      }
    }
    after = page.paging?.next?.after;
    if (!after) {
      r.done = true;
      return r;
    }
  }
}
