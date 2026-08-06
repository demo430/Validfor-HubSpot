// VC Pipeline deal kartinin ("About VC") otomatik dolan alanlari.
// Kart alanlari HubSpot UI'da olusturuldugu icin IC ADLARI kodda sabitlenmez:
// canli property listesinden ETIKETE gore cozulur (yanlis ic ad tahmini PATCH'i
// 400 ile bozardi). Bos-alan kurali gecerli: insanin girdigi deger asla ezilmez.
//
// Kartin SON alani (Likelihood) BILINCLI MANUEL — bu modul ona hic dokunmaz.
// "Deal Owner Validfor" upsert'teki ortak owner mantigiyla dolar; "Last
// Contacted" HubSpot'un meeting engagement'tan hesapladigi alandir — ikisi de
// burada yer almaz.
import * as hs from "./hubspot.js";
import type { MeetingExtract } from "./classify.js";

export type VcFieldKey =
  | "verticals" | "stages" | "regions" | "minTicket" | "maxTicket" | "type";

// Karttaki etiketler (ekran goruntusuyle birebir). Cozumleme normalize
// karsilastirma yaptigi icin parantez/bosluk/tire farklari sorun olmaz.
export const VC_CARD_LABELS: Record<VcFieldKey, string> = {
  verticals: "Investment Vertical(s)",
  stages: "Investment Stage",
  regions: "Investment Region",
  minTicket: "Minimum Ticket Size",
  maxTicket: "Maximum Ticket Size",
  type: "Investment Type",
};

export interface VcPropDef {
  name: string; // HubSpot ic adi (or. "investment_vertical_s_")
  type: string; // "enumeration" | "number" | "string" ...
  fieldType: string; // "checkbox" | "select" | "radio" | "number" | "text" ...
  options: Array<{ label: string; value: string }>;
}

// "Investment Vertical(s)" -> "investmentverticals"; "Co - Lead" -> "colead".
// Hem etiket hem ic ad hem enum secenegi ayni anahtara iner -> tum eslesmeler
// tek fonksiyonla yapilir.
export function normKey(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Property listesinden kart alanlarini cozer (SAF — testte sahte listeyle
// dogrulanir). Once etiket, bulunamazsa ic ad uzerinden eslesir. Cozulemeyen
// alan haritada olmaz -> o alan sessizce atlanir (patch bozulmaz).
export function resolveVcProps(
  allProps: Array<Record<string, any>>,
): Partial<Record<VcFieldKey, VcPropDef>> {
  const byKey = new Map<string, Record<string, any>>();
  for (const p of allProps || []) {
    const label = normKey(String(p?.label || ""));
    const name = normKey(String(p?.name || ""));
    // Etiket oncelikli: ayni anahtara dusen ikinci kayit ilkini ezmesin.
    if (label && !byKey.has(label)) byKey.set(label, p);
    if (name && !byKey.has(name)) byKey.set(name, p);
  }
  const out: Partial<Record<VcFieldKey, VcPropDef>> = {};
  for (const [key, label] of Object.entries(VC_CARD_LABELS) as Array<[VcFieldKey, string]>) {
    const p = byKey.get(normKey(label));
    if (!p || !p.name) continue;
    out[key] = {
      name: String(p.name),
      type: String(p.type || "string"),
      fieldType: String(p.fieldType || "text"),
      options: Array.isArray(p.options)
        ? p.options.map((o: any) => ({
            label: String(o?.label ?? ""),
            value: String(o?.value ?? ""),
          }))
        : [],
    };
  }
  return out;
}

// Cikarilan degerleri property tipine gore HubSpot'un kabul edecegi tek degere
// indirger (SAF). Doner: yazilacak deger; yazilacak bir sey yoksa null.
// - enumeration: degerler secenek listesine normalize eslenir; eslesmeyen atilir
//   (gecersiz enum degeri PATCH'i 400 ile dusurur). checkbox -> ";" ile coklu,
//   digerleri -> ilk eslesme.
// - number: yalniz sayisal girdi.
// - metin: coklu degerler ", " ile birlesir.
export function coerceVcValue(
  def: VcPropDef,
  values: Array<string | number>,
): string | number | null {
  const vals = values
    .map((v) => (typeof v === "number" ? v : String(v || "").trim()))
    .filter((v) => (typeof v === "number" ? isFinite(v) : v.length > 0));
  if (!vals.length) return null;

  if (def.type === "enumeration") {
    const matched: string[] = [];
    for (const v of vals) {
      const want = normKey(String(v));
      if (!want) continue;
      const opt = def.options.find(
        (o) => normKey(o.value) === want || normKey(o.label) === want,
      );
      if (opt && !matched.includes(opt.value)) matched.push(opt.value);
    }
    if (!matched.length) return null;
    return def.fieldType === "checkbox" ? matched.join(";") : matched[0];
  }
  if (def.type === "number") {
    const n = vals.find((v): v is number => typeof v === "number");
    return n ?? null;
  }
  return vals.map(String).join(", ");
}

// Bos-alan kuralli patch (SAF): yalniz cozulmus, dolu cikarilmis ve HubSpot'ta
// halihazirda BOS olan alanlar yazilir.
export function buildVcPatch(
  resolved: Partial<Record<VcFieldKey, VcPropDef>>,
  current: Record<string, string>,
  x: MeetingExtract,
): Record<string, string | number> {
  const wanted: Record<VcFieldKey, Array<string | number>> = {
    verticals: x.investmentVerticals,
    stages: x.investmentStages,
    regions: x.investmentRegions,
    minTicket: x.minTicketSize != null ? [x.minTicketSize] : [],
    maxTicket: x.maxTicketSize != null ? [x.maxTicketSize] : [],
    type: x.investmentType ? [x.investmentType] : [],
  };
  const patch: Record<string, string | number> = {};
  for (const [key, def] of Object.entries(resolved) as Array<[VcFieldKey, VcPropDef]>) {
    if (String(current[def.name] || "").trim()) continue; // insan verisi ezilmez
    const value = coerceVcValue(def, wanted[key]);
    if (value != null) patch[def.name] = value;
  }
  return patch;
}

// Cozumleme sonucu process omrunce onbelleklenir (webhook basina 1 ekstra GET
// yerine ilk VC toplantisinda 1 kez). Hata -> onbellek temizlenir ki sonraki
// kosum tekrar denesin.
let resolvedCache: Promise<Partial<Record<VcFieldKey, VcPropDef>>> | null = null;
export function resolveVcPropsLive(): Promise<Partial<Record<VcFieldKey, VcPropDef>>> {
  if (!resolvedCache) {
    resolvedCache = hs
      .getProperties("deals")
      .then((props) => {
        const r = resolveVcProps(props);
        const missing = (Object.keys(VC_CARD_LABELS) as VcFieldKey[]).filter((k) => !r[k]);
        if (missing.length) {
          console.error(
            `[vcfields] HubSpot'ta cozulmeyen VC kart alanlari (atlanacak): ` +
              missing.map((k) => VC_CARD_LABELS[k]).join(", "),
          );
        }
        return r;
      })
      .catch((e) => {
        resolvedCache = null;
        throw e;
      });
  }
  return resolvedCache;
}

// VC deal'inin kart alanlarini doldurur: cozumle -> mevcut degerleri oku ->
// yalniz bos alanlara yaz. Cagiran try/catch ile sarar (destekleyici adim).
export async function applyVcCardFields(dealId: string, x: MeetingExtract): Promise<void> {
  const resolved = await resolveVcPropsLive();
  const names = Object.values(resolved).map((d) => d.name);
  if (!names.length) return; // hicbir kart alani cozulemedi (loglandi)
  const live = await hs.getObject("deal", dealId, names);
  const current: Record<string, string> = {};
  for (const n of names) current[n] = String(live?.properties?.[n] || "").trim();
  const patch = buildVcPatch(resolved, current, x);
  if (Object.keys(patch).length) await hs.updateObject("deal", dealId, patch);
}
