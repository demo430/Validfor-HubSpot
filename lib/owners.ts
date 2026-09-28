// Mevcut deal'lara standart "Deal owner" (hubspot_owner_id) atar.
//
// Kural (kullanici karari): KARTTAKI "Deal Owner Validfor" KIM ISE
// standart Deal owner O OLUR. Ekipte demo yapan herkese seat alindigi icin
// bu adlarin karsiligi portalda birer HubSpot kullanicisidir.
//
// Otomasyon yeni kartlarda bu alani zaten dolduruyor (lib/upsert.ts); burasi
// GECMISE DONUK tek seferlik (ve tekrar calistirilabilir) supurme.
//
// Guvenlik agi:
//  - hubspot_owner_id DOLU olan kart hic okunmaz  -> elle atanmis owner ezilmez
//    (bos-alan kurali).
//  - Ad portalda tek bir kullaniciya denk gelmiyorsa kart ATLANIR ve raporda
//    "unresolved" olarak doner -> yanlis kisiye atama yok.
//  - dry=1 hicbir sey yazmaz, ne yapacagini rapor eder.
import * as hs from "./hubspot.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface OwnerBackfillResult {
  scanned: number;
  assigned: number;
  /** Ad -> kac kartta cozulemedi (portalda karsiligi yok ya da birden fazla). */
  unresolved: Record<string, number>;
  /** Yazilan/yazilacak eslemeler: "Kart adi" -> "Owner adi". */
  samples: Array<{ deal: string; owner: string; ownerId: string }>;
  /** false ise ayni URL tekrar cagrilmali (buyuk portal / sure butcesi). */
  done: boolean;
  errors: number;
}

const PAGE = 100;

/** Sahipsiz ama "Deal Owner Validfor" dolu deal'lari sayfa sayfa getirir. */
async function fetchPage(after?: string): Promise<{ results: any[]; after?: string }> {
  const body: any = {
    filterGroups: [
      {
        filters: [
          { propertyName: "deal_owner_validfor", operator: "HAS_PROPERTY" },
          { propertyName: "hubspot_owner_id", operator: "NOT_HAS_PROPERTY" },
        ],
      },
    ],
    properties: ["dealname", "deal_owner_validfor", "hubspot_owner_id"],
    limit: PAGE,
  };
  if (after) body.after = after;
  const json = await hs.hsFetch<{ results?: any[]; paging?: any }>(
    "/crm/v3/objects/deals/search",
    { method: "POST", body },
  );
  return { results: json.results || [], after: json.paging?.next?.after };
}

/** Toplu PATCH — 100 kayda kadar TEK istek (arama limitini yormaz). */
async function batchUpdate(inputs: Array<{ id: string; properties: any }>): Promise<void> {
  if (!inputs.length) return;
  await hs.hsFetch("/crm/v3/objects/deals/batch/update", {
    method: "POST",
    body: { inputs },
  });
}

export async function backfillDealOwners(opts: {
  dry?: boolean;
  max?: number;
  budgetMs?: number;
} = {}): Promise<OwnerBackfillResult> {
  const dry = Boolean(opts.dry);
  const max = Math.max(1, opts.max ?? 500);
  const budgetMs = opts.budgetMs ?? 45_000;
  const startedAt = Date.now();

  const out: OwnerBackfillResult = {
    scanned: 0,
    assigned: 0,
    unresolved: {},
    samples: [],
    done: true,
    errors: 0,
  };

  // Owner listesi bir kez cekilir; ad -> id cozumlemesi bellekten yapilir.
  // Liste alinamazsa (ornegin private app'te crm.objects.owners.read yoksa)
  // VALIDFOR_OWNER_MAP yedek yolu varsa kosuma DEVAM edilir; o da yoksa
  // hicbir ad cozulemeyecegi icin bosuna kart taranmaz.
  hs.clearOwnersCache();
  try {
    await hs.listOwners();
  } catch (e: any) {
    console.error("[owner-backfill] owner listesi alinamadi:", e?.message || e);
    out.errors++;
    if (!hs.envOwnerMapSize()) return out;
    console.log(
      `[owner-backfill] VALIDFOR_OWNER_MAP ile devam ediliyor ` +
        `(${hs.envOwnerMapSize()} eslesme)`,
    );
  }

  // 1) ONCE TOPLA (yazmadan): sayfalama sirasinda kayit guncellenirse arama
  //    sonucu kayar ve imlec kayit atlar. Bu yuzden okuma bitmeden yazmiyoruz.
  const candidates: any[] = [];
  let after: string | undefined;
  while (candidates.length < max) {
    if (Date.now() - startedAt > budgetMs) {
      out.done = false;
      break;
    }
    let page: { results: any[]; after?: string };
    try {
      page = await fetchPage(after);
    } catch (e: any) {
      console.error("[owner-backfill] arama hatasi:", e?.message || e);
      out.errors++;
      out.done = false;
      break;
    }
    candidates.push(...page.results);
    if (!page.after) break;
    after = page.after;
    out.done = false; // sayfa varsa: max/butce yetmezse tekrar cagrilmali
    await sleep(350); // HubSpot 4 istek/sn freni
  }
  if (candidates.length > max) candidates.length = max;
  else if (!after) out.done = true;

  // 2) SONRA COZ VE YAZ.
  const resolved = new Map<string, string>(); // normalize ad -> ownerId ("" = cozulemedi)
  const inputs: Array<{ id: string; properties: any }> = [];
  for (const d of candidates) {
    out.scanned++;
    const name = String(d?.properties?.deal_owner_validfor || "").trim();
    const dealName = String(d?.properties?.dealname || d?.id || "");
    if (!name) continue;

    const key = hs.normPersonName(name);
    if (!resolved.has(key)) resolved.set(key, await hs.resolveOwnerId({ name }));
    const ownerId = resolved.get(key) || "";
    if (!ownerId) {
      out.unresolved[name] = (out.unresolved[name] || 0) + 1;
      continue;
    }
    if (out.samples.length < 50) out.samples.push({ deal: dealName, owner: name, ownerId });
    inputs.push({ id: String(d.id), properties: { hubspot_owner_id: ownerId } });
  }
  out.assigned = inputs.length;

  if (!dry) {
    for (let i = 0; i < inputs.length; i += PAGE) {
      const chunk = inputs.slice(i, i + PAGE);
      try {
        await batchUpdate(chunk);
      } catch (e: any) {
        console.error("[owner-backfill] toplu yazma hatasi:", e?.message || e);
        out.errors++;
        out.assigned -= chunk.length;
        out.done = false;
      }
      await sleep(350);
    }
  }

  return out;
}
