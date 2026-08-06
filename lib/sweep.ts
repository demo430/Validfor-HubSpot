// Hareketsiz deal supurucusu: iki pipeline'da da "Meeting" stage'inde olup
// 7 gundur hareket gormeyen deal'lari Follow-Up'a tasir (gunluk cron).
//
// "Hareket" tanimi: HubSpot Last Activity (notes_last_updated — loglanan not/
// e-posta/arama/toplanti/gorev) ile ff_last_meeting_date'in EN YENISI; ikisi
// de yoksa createdate. Yalniz Meeting'den tasinir: giris stage'leri (henuz
// toplanti yok) ve manuel bolge (Follow-Up sonrasi) ASLA ellenmez — supurucu
// hicbir deal'i geri goturmez.
import * as hs from "./hubspot.js";
import { PIPELINE_ID, STAGE, VC_PIPELINE_ID, VC_STAGE } from "./upsert.js";

export const DEFAULT_STALE_DAYS = 7;

export const SWEEP_TARGETS = [
  { pipelineId: PIPELINE_ID, label: "Sales", from: STAGE.meeting, to: STAGE.followUp },
  { pipelineId: VC_PIPELINE_ID, label: "VC", from: VC_STAGE.meeting, to: VC_STAGE.followUp },
] as const;

// SAF: deal'in son hareket zamani (epoch ms). Hicbir tarih parse edilemezse
// null -> supurucu dokunmaz (yanlis pozitif tasima olmasin).
export function lastActivityMs(props: Record<string, unknown>): number | null {
  const parse = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const t = new Date(String(v)).getTime();
    return isNaN(t) ? null : t;
  };
  const acts = [parse(props?.notes_last_updated), parse(props?.ff_last_meeting_date)]
    .filter((x): x is number => x != null);
  if (acts.length) return Math.max(...acts);
  return parse(props?.createdate);
}

// SAF: days gundur hareket yok mu?
export function isStale(
  props: Record<string, unknown>,
  days: number,
  nowMs: number,
): boolean {
  const last = lastActivityMs(props);
  if (last == null) return false; // bilinmiyor -> dokunma
  return nowMs - last >= days * 86_400_000;
}

export interface SweepResult {
  checked: number; // Meeting'de bakilan deal
  moved: number; //   Follow-Up'a tasinan (dry'da: tasinacak)
  fresh: number; //   hareketi taze -> yerinde birakildi
  errors: number;
  /** "[Sales] Acme: Meeting -> Follow-Up (9 gundur hareketsiz)" satirlari. */
  items: string[];
}

export async function sweepStaleDeals(
  opts: { days?: number; dry?: boolean } = {},
): Promise<SweepResult> {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  const days = opts.days ?? DEFAULT_STALE_DAYS;
  const dry = !!opts.dry;
  const now = Date.now();
  const r: SweepResult = { checked: 0, moved: 0, fresh: 0, errors: 0, items: [] };
  const note = (line: string): void => {
    if (r.items.length < 200) r.items.push(line);
  };

  for (const t of SWEEP_TARGETS) {
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body: Record<string, unknown> = {
        filterGroups: [
          {
            filters: [
              { propertyName: "pipeline", operator: "EQ", value: t.pipelineId },
              { propertyName: "dealstage", operator: "EQ", value: t.from },
            ],
          },
        ],
        properties: ["dealname", "notes_last_updated", "ff_last_meeting_date", "createdate"],
        limit: 100,
        ...(after ? { after } : {}),
      };
      const json = await hs.hsFetch<{ results?: any[]; paging?: any }>(
        "/crm/v3/objects/deals/search",
        { method: "POST", body },
      );
      for (const d of json.results || []) {
        r.checked++;
        const props = d.properties || {};
        const name = String(props.dealname || "").trim() || d.id;
        try {
          if (!isStale(props, days, now)) {
            r.fresh++;
            continue;
          }
          if (!dry) {
            await hs.updateObject("deal", d.id, {
              pipeline: t.pipelineId,
              dealstage: t.to,
            });
          }
          r.moved++;
          const idleDays = Math.floor((now - (lastActivityMs(props) ?? now)) / 86_400_000);
          note(`[${t.label}] ${name}: Meeting -> Follow-Up (${idleDays} gundur hareketsiz)`);
        } catch (e: any) {
          r.errors++;
          note(`HATA [${t.label}] ${name}: ${String(e?.message || e).slice(0, 160)}`);
        }
      }
      after = json.paging?.next?.after;
      if (!after) break;
    }
  }
  return r;
}

// --- Giris tutarsizligi supurucusu (kullanici kurali) ---
// "Scheduled/Unassigned'da duran bir deal'in ISLENMIS Fireflies toplantisi
// OLAMAZ — varsa dogrudan Meeting'e tasi." (VC aynasi: Contacted -> Meeting.)
// Kaynak: ff_processed_transcripts dolu = toplanti islenmis. Ileri tasima
// oldugu icin guvenli; manuel bolgeye asla dokunmaz.
export const ENTRY_FIX_TARGETS = [
  { pipelineId: PIPELINE_ID, label: "Sales", from: [STAGE.unassigned, STAGE.scheduled], to: STAGE.meeting },
  { pipelineId: VC_PIPELINE_ID, label: "VC", from: [VC_STAGE.contacted], to: VC_STAGE.meeting },
] as const;

export interface EntryFixResult {
  checked: number;
  moved: number;
  errors: number;
  items: string[];
}

export async function sweepEntryMismatch(
  opts: { dry?: boolean } = {},
): Promise<EntryFixResult> {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  const dry = !!opts.dry;
  const r: EntryFixResult = { checked: 0, moved: 0, errors: 0, items: [] };
  for (const t of ENTRY_FIX_TARGETS) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "pipeline", operator: "EQ", value: t.pipelineId },
            { propertyName: "dealstage", operator: "IN", values: [...t.from] },
            { propertyName: "ff_processed_transcripts", operator: "HAS_PROPERTY" },
          ],
        },
      ],
      properties: ["dealname", "dealstage"],
      limit: 100,
    };
    try {
      const json = await hs.hsFetch<{ results?: any[] }>(
        "/crm/v3/objects/deals/search",
        { method: "POST", body },
      );
      for (const d of json.results || []) {
        r.checked++;
        try {
          if (!dry) {
            await hs.updateObject("deal", String(d.id), {
              pipeline: t.pipelineId,
              dealstage: t.to,
            });
          }
          r.moved++;
          if (r.items.length < 100) {
            r.items.push(`${t.label}: "${d.properties?.dealname}" -> Meeting (islenmis toplantisi var)`);
          }
        } catch (e: any) {
          r.errors++;
          if (r.items.length < 100) {
            r.items.push(`HATA ${d.properties?.dealname}: ${String(e?.message || e).slice(0, 120)}`);
          }
        }
      }
    } catch (e: any) {
      r.errors++;
      if (r.items.length < 100) {
        r.items.push(`HATA arama (${t.label}): ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  }
  return r;
}
