// HubSpot REST yardimcilari. Node 18+ global fetch/FormData/Blob kullanir.
// EU/NA: varsayilan api.hubapi.com tum hesaplarda calisir (token bolgeyi yonlendirir).
// Gerekirse .env.local'de HUBSPOT_API_BASE=https://api-eu1.hubapi.com ile degistir.
//
// DOMiNO'dan trimlenmis surum: sadece cekirdek primitifler (Fireflies -> Claude
// Routine -> HubSpot + transkript PDF akisi icin gerekenler). Trello/Notion/dedup
// bakim fonksiyonlari cikarildi.

export class HubSpotError extends Error {
  status?: number;
  body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "HubSpotError";
    this.status = status;
    this.body = body;
  }
}

export function apiBase(): string {
  let b = process.env.HUBSPOT_API_BASE || "https://api.hubapi.com";
  while (b.length > 0 && b.endsWith("/")) b = b.slice(0, -1);
  return b;
}

function token(): string {
  const t = process.env.HUBSPOT_TOKEN;
  if (!t) throw new Error("HUBSPOT_TOKEN tanimli degil");
  return t;
}

export interface HsFetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function hsFetch<T = any>(
  pathname: string,
  opts: HsFetchOpts = {},
): Promise<T> {
  const url = pathname.startsWith("http") ? pathname : apiBase() + pathname;
  const method = (opts.method || "GET").toUpperCase();
  // 429: her metodda guvenli (istek islenmedi). 5xx: yalnizca idempotent
  // metodlarda (POST create'i tekrarlamak mukerrer kayit yaratabilir).
  const idempotent = method === "GET" || method === "PUT" || method === "PATCH";
  const MAX_TRIES = 3;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token()}`,
      ...(opts.headers || {}),
    };
    let body: any = opts.body;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (body && !isForm && typeof body !== "string") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        // ust sinir: askida kalan istek tum webhook'u kilitlemesin
        signal: AbortSignal.timeout(opts.timeoutMs || 15000),
      });
    } catch (e) {
      // Ag hatasi/timeout: idempotent ise tekrar dene
      lastErr = e;
      if (idempotent && attempt < MAX_TRIES) {
        await sleep(1000 * attempt);
        continue;
      }
      throw e;
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (res.ok) return json as T;

    const retryable =
      res.status === 429 || (idempotent && res.status >= 500 && res.status <= 599);
    if (retryable && attempt < MAX_TRIES) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(!isNaN(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 1000 * attempt);
      continue;
    }
    throw new HubSpotError(
      `HubSpot ${res.status} ${method} ${pathname}: ${text.slice(0, 600)}`,
      res.status,
      json,
    );
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const TYPE_PLURAL: Record<string, string> = {
  company: "companies",
  companies: "companies",
  contact: "contacts",
  contacts: "contacts",
  deal: "deals",
  deals: "deals",
  note: "notes",
  notes: "notes",
  meeting: "meetings",
  meetings: "meetings",
};
export const plural = (t: string): string => TYPE_PLURAL[t] || t;

// --- Dosya yukleme (transkript PDF) ---
export interface UploadOpts {
  contentType?: string;
  access?: string;
  folderPath?: string;
}
export async function uploadFile(
  buffer: Buffer | Uint8Array,
  filename: string,
  options: UploadOpts = {},
): Promise<string> {
  const form = new FormData();
  // Uint8Array kopyasi: Buffer, NodeNext tiplerinde BlobPart'a atanamiyor.
  const bytes = new Uint8Array(buffer);
  const blob = new Blob([bytes], { type: options.contentType || "application/pdf" });
  form.append("file", blob, filename);
  form.append(
    "options",
    JSON.stringify({ access: options.access || "PRIVATE", overwrite: false }),
  );
  form.append("folderPath", options.folderPath || "/fireflies-transcripts");
  const json = await hsFetch<{ id: string }>("/files/v3/files", {
    method: "POST",
    body: form,
    // Multipart yukleme + HubSpot dosya isleme 15s'e sigmayabilir (buyuk PDF).
    timeoutMs: 40000,
  });
  return json.id;
}

// --- Not olusturma ---
// Iliskiler create govdesinde INLINE verilir: not ya tam bagli olusur ya hic
// olusmaz (create ile associate arasindaki cokme penceresi oksuz not birakmaz).
// HubSpot tanimli association type ID'leri: note->company 190, note->contact 202,
// note->deal 214.
const NOTE_ASSOC_TYPE: Record<string, number> = {
  company: 190,
  contact: 202,
  deal: 214,
};
export interface CreateNoteInput {
  body?: string;
  timestamp?: number | string;
  attachmentIds?: string | string[];
  /** Inline iliskiler: { company: [id], deal: [id], contact: [id, ...] } */
  associations?: Partial<Record<"company" | "contact" | "deal", string[]>>;
}
export async function createNote({
  body,
  timestamp,
  attachmentIds,
  associations,
}: CreateNoteInput): Promise<string> {
  const properties: Record<string, string> = {
    hs_note_body: body || "",
    hs_timestamp: timestamp != null ? String(timestamp) : String(Date.now()),
  };
  if (attachmentIds) {
    properties.hs_attachment_ids = Array.isArray(attachmentIds)
      ? attachmentIds.join(";")
      : String(attachmentIds);
  }
  const assoc: any[] = [];
  for (const [toType, ids] of Object.entries(associations || {})) {
    for (const id of ids || []) {
      assoc.push({
        to: { id: String(id) },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: NOTE_ASSOC_TYPE[toType],
          },
        ],
      });
    }
  }
  const json = await hsFetch<{ id: string }>("/crm/v3/objects/notes", {
    method: "POST",
    body: assoc.length ? { properties, associations: assoc } : { properties },
  });
  return json.id;
}

// --- Meeting engagement olusturma ---
// Not'tan farki: loglanan meeting HubSpot'un "Last Contacted" / "Last Activity"
// hesaplanan alanlarini gunceller (notlar guncellemez).
export interface CreateMeetingInput {
  title: string;
  body?: string;
  startMs: number;
  endMs?: number;
  /** Varsayilan COMPLETED; karsi taraf gelmediyse NO_SHOW. */
  outcome?: "COMPLETED" | "NO_SHOW";
}
export async function createMeeting({
  title,
  body,
  startMs,
  endMs,
  outcome,
}: CreateMeetingInput): Promise<string> {
  const properties: Record<string, string> = {
    hs_timestamp: String(startMs),
    hs_meeting_title: title,
    hs_meeting_start_time: String(startMs),
    hs_meeting_outcome: outcome || "COMPLETED",
  };
  if (body) properties.hs_meeting_body = body;
  if (endMs && endMs > startMs) properties.hs_meeting_end_time = String(endMs);
  const json = await hsFetch<{ id: string }>("/crm/v3/objects/meetings", {
    method: "POST",
    body: { properties },
  });
  return json.id;
}

// --- v4 "default" iliskilendirme (association type ID gerektirmez) ---
export async function associateDefault(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
): Promise<unknown> {
  return hsFetch(
    `/crm/v4/objects/${plural(fromType)}/${fromId}/associations/default/${plural(toType)}/${toId}`,
    { method: "PUT" },
  );
}

// --- Bir notun bagli oldugu kayitlar ---
// 404 -> o tip icin bos liste. Gecici hata (429/5xx/timeout) -> FIRLATIR:
// "iliski yok" ile "okunamadi" ayni sey degil.
export interface NoteAssociations {
  companies: string[];
  contacts: string[];
  deals: string[];
}
export async function getNoteAssociations(
  noteId: string,
): Promise<NoteAssociations> {
  const out: NoteAssociations = { companies: [], contacts: [], deals: [] };
  for (const type of ["companies", "contacts", "deals"] as const) {
    try {
      const json = await hsFetch<{ results?: any[] }>(
        `/crm/v4/objects/notes/${noteId}/associations/${type}?limit=100`,
      );
      out[type] = (json.results || [])
        .map((r: any) => r.toObjectId || (r.to && r.to.id))
        .filter(Boolean)
        .map(String);
    } catch (e: any) {
      if (e && e.status === 404) continue; // kayit yok -> bos, devam
      throw e; // gecici hata -> yukari firlat (retry edilebilir)
    }
  }
  return out;
}

// --- Bir kaydin belirli tipteki iliskili kayitlari (or. company -> contacts) ---
// Sayfalama: 100'luk sayfalar, savunmaci ust sinir 10 sayfa.
export async function getAssociations(
  fromType: string,
  fromId: string,
  toType: string,
): Promise<string[]> {
  try {
    const out: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const qs = `?limit=100${after ? "&after=" + encodeURIComponent(after) : ""}`;
      const json = await hsFetch<{ results?: any[]; paging?: any }>(
        `/crm/v4/objects/${plural(fromType)}/${fromId}/associations/${plural(toType)}${qs}`,
      );
      for (const r of json.results || []) {
        const id = r.toObjectId || (r.to && r.to.id);
        if (id) out.push(String(id));
      }
      after = json.paging?.next?.after;
      if (!after) break;
    }
    return out;
  } catch {
    return [];
  }
}

// --- Notlari ara (varsayilan: son X gun, en yeni once) ---
export interface SearchNotesOpts {
  createdAfter?: number | string;
  contains?: string;
  properties?: string[];
  limit?: number;
  after?: string;
}
export async function searchNotes(opts: SearchNotesOpts = {}): Promise<any> {
  const filters: any[] = [];
  if (opts.createdAfter)
    filters.push({
      propertyName: "hs_createdate",
      operator: "GTE",
      value: String(opts.createdAfter),
    });
  if (opts.contains)
    filters.push({
      propertyName: "hs_note_body",
      operator: "CONTAINS_TOKEN",
      value: opts.contains,
    });
  const body: any = {
    filterGroups: filters.length ? [{ filters }] : [],
    properties: opts.properties || [
      "hs_note_body",
      "hs_timestamp",
      "hs_attachment_ids",
      "hs_createdate",
    ],
    sorts: [{ propertyName: "hs_createdate", direction: "DESCENDING" }],
    limit: opts.limit || 100,
  };
  if (opts.after) body.after = opts.after;
  return hsFetch("/crm/v3/objects/notes/search", { method: "POST", body });
}

// --- Deal'i ada gore ara (backfill/dedup icin). Buyuk/kucuk harf + bosluk toleransli.
// Normalize-tam eslesme TEK ise onu doner. BIRDEN COK eslesme (mukerrer kayit)
// varsa null DONMEZ: null her toplantida YENI bir mukerrer deal yaratip sarmali
// buyutur. Bunun yerine en eski (createdate) deal'i secer ve yuksek sesle loglar
// — insan HubSpot'ta merge edene kadar sistem tek deal uzerinde calismaya devam
// eder. ---
export async function searchDealsByName(name: string): Promise<any | null> {
  if (!name) return null;
  const want = String(name).trim().toLowerCase();
  const norm = (s: any) => String(s || "").trim().toLowerCase();
  const run = async (operator: string) => {
    const body = {
      filterGroups: [
        { filters: [{ propertyName: "dealname", operator, value: String(name) }] },
      ],
      properties: ["dealname", "dealstage", "createdate"],
      limit: 100,
    };
    const json = await hsFetch<{ results?: any[] }>(
      "/crm/v3/objects/deals/search",
      { method: "POST", body },
    );
    return (json.results || []).filter(
      (d: any) => norm(d.properties?.dealname) === want,
    );
  };
  let r = await run("EQ");
  if (!r.length) r = await run("CONTAINS_TOKEN"); // EQ buyuk/kucuk harf duyarli -> tolerans
  if (!r.length) return null;
  if (r.length > 1) {
    r.sort(
      (a: any, b: any) =>
        new Date(a.properties?.createdate || a.createdAt || 0).getTime() -
        new Date(b.properties?.createdate || b.createdAt || 0).getTime(),
    );
    console.error(
      `[hubspot] UYARI: "${name}" adinda ${r.length} mukerrer deal var ` +
        `(${r.map((d: any) => d.id).join(", ")}). En eskisi (${r[0].id}) kullaniliyor — ` +
        `HubSpot'ta elle merge edin.`,
    );
  }
  return r[0];
}

// --- Property (ozel alan) yonetimi ---
export async function getProperties(objectType: string): Promise<any[]> {
  const json = await hsFetch<{ results?: any[] }>(
    `/crm/v3/properties/${objectType}`,
  );
  return json.results || [];
}

export async function ensurePropertyGroup(
  objectType: string,
  name: string,
  label: string,
): Promise<"created" | "exists"> {
  try {
    await hsFetch(`/crm/v3/properties/${objectType}/groups`, {
      method: "POST",
      body: { name, label },
    });
    return "created";
  } catch (e: any) {
    if (e.status === 409) return "exists";
    throw e;
  }
}

export async function createProperty(
  objectType: string,
  def: Record<string, unknown>,
): Promise<"created" | "exists"> {
  try {
    await hsFetch(`/crm/v3/properties/${objectType}`, { method: "POST", body: def });
    return "created";
  } catch (e: any) {
    if (e.status === 409) return "exists";
    throw e;
  }
}

// Var olan bir property'yi gunceller (or. label degistirmek, enum secenegi eklemek).
export async function updateProperty(
  objectType: string,
  name: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return hsFetch(`/crm/v3/properties/${objectType}/${name}`, {
    method: "PATCH",
    body: patch,
  });
}

// --- Generic obje read/write ---
export async function getObject(
  objectType: string,
  id: string,
  properties?: string[],
): Promise<any> {
  const qs =
    properties && properties.length ? `?properties=${properties.join(",")}` : "";
  return hsFetch(`/crm/v3/objects/${plural(objectType)}/${id}${qs}`);
}

export async function updateObject(
  objectType: string,
  id: string,
  properties: Record<string, unknown>,
): Promise<any> {
  return hsFetch(`/crm/v3/objects/${plural(objectType)}/${id}`, {
    method: "PATCH",
    body: { properties },
  });
}

// --- Generic obje olustur ---
export async function createObject(
  objectType: string,
  properties: Record<string, unknown>,
): Promise<any> {
  return hsFetch(`/crm/v3/objects/${plural(objectType)}`, {
    method: "POST",
    body: { properties },
  });
}

// --- Tek bir property'ye gore ara (ilk eslesme veya null) ---
// Bul-olustur icin: company domain, contact email, vb.
export async function searchByProperty(
  objectType: string,
  propertyName: string,
  operator: string,
  value: string,
  properties?: string[],
): Promise<any | null> {
  if (!value) return null;
  const body = {
    filterGroups: [{ filters: [{ propertyName, operator, value: String(value) }] }],
    properties: properties || [propertyName],
    limit: 2,
  };
  const json = await hsFetch<{ results?: any[] }>(
    `/crm/v3/objects/${plural(objectType)}/search`,
    { method: "POST", body },
  );
  const r = json.results || [];
  return r.length ? r[0] : null;
}

// --- Token / portal dogrulama ---
export async function whoAmI(): Promise<any> {
  return hsFetch("/account-info/v3/details");
}

// --- Owner (deal sahibi) cozumleme ---
// Portalda seat acildikca ekip HubSpot KULLANICISI olur; otomasyon toplantiyi
// yapan kisiyi standart "Deal owner" (hubspot_owner_id) alanina da yazabilsin
// diye ad/e-posta -> ownerId eslemesi burada. Liste kucuk ve nadiren degisir,
// koşum boyunca bir kez cekilir.
let ownersCache: Promise<any[]> | null = null;

export function clearOwnersCache(): void {
  ownersCache = null;
}

export async function listOwners(): Promise<any[]> {
  if (!ownersCache) {
    ownersCache = hsFetch<{ results?: any[] }>("/crm/v3/owners?limit=100")
      .then((j) => j.results || [])
      .catch((e) => {
        ownersCache = null; // sonraki kosum tekrar denesin
        throw e;
      });
  }
  return ownersCache;
}

/**
 * Kisi adini karsilastirilabilir hale getirir.
 *
 * Turkce/aksanli harfler ASCII'ye katlanir ("Omer Cimen" ile "Ömer Çimen" ayni
 * kisidir), noktalama bosluga cevrilir, bosluklar tekillesir. HubSpot'taki
 * kullanici adi ile karttaki "Deal Owner Validfor" metni farkli yazilmis
 * olabilir; eslesme bu normalizasyon uzerinden yapilir.
 */
export function normPersonName(name: string): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // aksan isaretlerini dusur
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Owner kaydindan tam adi uretir ("Omer" + "Cimen" -> "omer cimen"). */
function ownerFullName(o: any): string {
  return normPersonName([o?.firstName, o?.lastName].filter(Boolean).join(" "));
}

// --- Owners API'sine erisilemedigi durum icin ELLE eslesme (yedek yol) ---
//
// `/crm/v3/owners` cagrisi `crm.objects.owners.read` scope'u ister. Private
// app'e bu izin verilmemisse HubSpot 403 doner ve otomasyon hicbir owner
// cozemez -> Deal owner alani sessizce bos kalir. Bu env degiskeni o durumda
// devreye girer.
//
// Bicim: virgulle ayrilmis `anahtar:ownerId` ciftleri. Anahtar ya bir E-POSTA
// ya da bir AD olabilir; ad aranirken normalize edilir (aksan/noktalama farki
// onemli degil). Ornek:
//
//   VALIDFOR_OWNER_MAP="ada.lovelace@ornek.com:11111111,Ada Lovelace:11111111,Ada:11111111"
//
// NOT: Bu yalnizca YEDEK. Owners API'si calisiyorsa ONCE o kullanilir, cunku
// portaldaki gercek durumu yansitir ve seat degisikliklerinde kendini gunceller.
let envOwnerMapCache: { raw: string; map: Map<string, string> } | null = null;

function envOwnerMap(): Map<string, string> {
  const raw = String(process.env.VALIDFOR_OWNER_MAP || "").trim();
  if (envOwnerMapCache && envOwnerMapCache.raw === raw) return envOwnerMapCache.map;
  const map = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const entry = pair.trim();
    if (!entry) continue;
    const idx = entry.lastIndexOf(":"); // ad/e-posta icinde ':' olmaz, yine de sondan ayir
    if (idx <= 0) continue;
    const key = entry.slice(0, idx).trim();
    const id = entry.slice(idx + 1).trim();
    if (!key || !/^\d+$/.test(id)) continue; // ownerId yalniz rakam
    map.set(key.includes("@") ? key.toLowerCase() : normPersonName(key), id);
  }
  envOwnerMapCache = { raw, map };
  return map;
}

/** Env haritasindan cozer; eslesme yoksa "" doner. */
function ownerIdFromEnv(email: string, name: string): string {
  const map = envOwnerMap();
  if (!map.size) return "";
  if (email && map.has(email)) return map.get(email) as string;
  if (name && map.has(name)) return map.get(name) as string;
  return "";
}

/**
 * Toplantiyi yapan kisiyi HubSpot owner ID'sine cevirir.
 *
 * Sirasiyla:
 *   1. Owners API + E-POSTA  (tekil ve guvenilir)
 *   2. Owners API + TAM AD   (birden fazla kisiye denk gelirse ATLANIR)
 *   3. Owners API + tek ad   ("Bharani" -> portalda o adda TEK kisi varsa)
 *   4. VALIDFOR_OWNER_MAP    (API erisilemezse ya da eslesme cikmazsa)
 *
 * Hicbiri tutmazsa "" doner — yanlis kisiye atamaktansa alan bos birakilir.
 */
export async function resolveOwnerId(input: {
  email?: string;
  name?: string;
}): Promise<string> {
  const email = String(input.email || "").toLowerCase().trim();
  const name = normPersonName(input.name || "");
  if (!email && !name) return "";

  let owners: any[] = [];
  try {
    owners = await listOwners();
  } catch (e: any) {
    // API yoksa akis KESILMEZ; asagida env haritasina dusulur.
    console.error("[hubspot] owner listesi alinamadi:", e?.message || e);
  }
  const active = owners.filter((o) => !o?.archived);

  if (email) {
    const hit = active.find((o) => String(o?.email || "").toLowerCase().trim() === email);
    if (hit?.id) return String(hit.id);
  }
  if (name) {
    const hits = active.filter((o) => ownerFullName(o) === name);
    if (hits.length === 1 && hits[0]?.id) return String(hits[0].id);
    // Kartta yalniz ad yaziyorsa ("Bharani") ve portalda o ada sahip TEK kisi
    // varsa o kisidir. Birden fazlaysa belirsiz -> env haritasina dusulur.
    if (!name.includes(" ")) {
      const firsts = active.filter((o) => normPersonName(o?.firstName) === name);
      if (firsts.length === 1 && firsts[0]?.id) return String(firsts[0].id);
    }
  }
  return ownerIdFromEnv(email, name);
}

/** Env yedek haritasinda kac eslesme tanimli (tani/rapor icin). */
export function envOwnerMapSize(): number {
  return envOwnerMap().size;
}
