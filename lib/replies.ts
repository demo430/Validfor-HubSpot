// Musteri cevabi supurucusu: demo SONRASI gercek bir yanit gelmis Sales
// kartlarini "In Progress"e tasir (gunluk cron, stage-sweep icinden).
//
// Kullanici kurali (2026-09):
//   Follow-Up   : demo yapildi, demo sonrasi cevap HENUZ yok
//   In Progress : demo yapildi, cevap GELDI (olumlu ya da olumsuz) — takipte
// Cevabin OLUMLU mu OLUMSUZ mu oldugu AYIRT EDILMEZ; ikisi de In Progress'tir.
// Karari insan verir, otomasyon yalnizca "cevap geldi mi" sorusunu yanitlar.
//
// --- NEDEN hs_email_direction'a GUVENILMEZ ---
// HubSpot'ta BCC/forward ile loglanan GIDEN mailler de
// hs_email_direction=INCOMING_EMAIL olarak dusuyor. Portalda dogrulanan ornek:
//   konu "Following up on our last conversation - Validfor"
//   direction INCOMING_EMAIL, from elif.yesil@validfor.com  -> BIZIM giden mail
// Bu yuzden tek guvenilir test GONDEREN domaini: ic domain degilse musteri
// yaniti. Ayrica otomatik yanitlar ("Automatic reply: ...") ve takvim
// davetleri ("Invitation: ...", "Accepted: ...") konu kalibiyla atilir —
// bunlar da INCOMING_EMAIL olarak dusuyor ama insan cevabi degil.
import * as hs from "./hubspot.js";
import { PIPELINE_ID, STAGE, isInternalEmail } from "./upsert.js";

// Otomatik yanit / takvim bildirimi konu kaliplari. Insan yazmadigi icin
// "cevap geldi" saymayiz. Basta "Re:" olabilir (yanitlanmis auto-reply).
// DIKKAT: ":" ile biten kalibin ardina \b KOYULAMAZ — ":" ve sonraki bosluk
// ikisi de kelime-disi karakter oldugu icin orada kelime siniri YOKTUR
// ("Auto: I am away" eslesmezdi). O yuzden "auto:" ayri bir dal.
export const AUTO_SUBJECT_RE =
  /^\s*(?:re\s*:\s*|fwd?\s*:\s*)*(?:(?:automatic reply|auto(?:matic)? response|autoreply|out of (?:the )?office|otomatik yan[ıi]t|ofis d[ıi][sş][ıi]nda|abwesenheit|r[eé]ponse automatique|risposta automatica|respuesta autom[aá]tica|invitation|updated invitation|invitation update|canceled event|cancelled event|accepted|declined|tentative|davet|toplant[ıi] daveti|undeliverable|mail delivery|delivery status notification)\b|auto\s*:)/i;

export interface ReplyCandidate {
  /** hs_email_from_email */
  from?: string | null;
  /** hs_email_subject */
  subject?: string | null;
  /** hs_timestamp */
  timestamp?: string | null;
}

/**
 * SAF: bu e-posta engagement'i gercek bir MUSTERI yaniti mi?
 * direction'a bakmaz (guvenilmez — dosya basindaki nota bak).
 */
export function isCustomerReply(e: ReplyCandidate): boolean {
  const from = String(e?.from || "")
    .trim()
    .toLowerCase();
  if (!from.includes("@")) return false; // gonderen bilinmiyor -> sayma
  if (isInternalEmail(from)) return false; // bizim giden/otomatik mailimiz
  if (AUTO_SUBJECT_RE.test(String(e?.subject || ""))) return false;
  return true;
}

/** SAF: epoch ms'e cevir; parse edilemezse null. */
export function parseMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  const t = new Date(String(v)).getTime();
  return isNaN(t) ? null : t;
}

/**
 * SAF: demo tarihi (epoch ms). ff_last_meeting_date varsa o, yoksa
 * createdate. Ikisi de yoksa null -> kart atlanir (yanlis tasima olmasin).
 */
export function demoMs(props: Record<string, unknown>): number | null {
  return parseMs(props?.ff_last_meeting_date) ?? parseMs(props?.createdate);
}

/**
 * SAF: verilen e-postalar arasinda demo tarihinden SONRA gelen ilk musteri
 * yanitini bulur (en yeni degil, varligi yeter; loglamak icin en yenisini
 * doner). Yoksa null.
 */
export function findReply(
  emails: ReplyCandidate[],
  afterMs: number,
): (ReplyCandidate & { ms: number }) | null {
  let best: (ReplyCandidate & { ms: number }) | null = null;
  for (const e of emails) {
    const ms = parseMs(e?.timestamp);
    if (ms == null || ms <= afterMs) continue;
    if (!isCustomerReply(e)) continue;
    if (!best || ms > best.ms) best = { ...e, ms };
  }
  return best;
}

// Yalniz Sales pipeline. Meeting VE Follow-Up'tan In Progress'e tasinir;
// manuel bolgeye (Contract/PoC/Won/Lost/No show/Partnership) DOKUNULMAZ ve
// hicbir kart GERI goturulmez.
export const REPLY_FROM_STAGES: string[] = [STAGE.meeting, STAGE.followUp];
export const REPLY_TO_STAGE: string = STAGE.inProgress;

const EMAIL_PROPS = [
  "hs_email_from_email",
  "hs_email_subject",
  "hs_timestamp",
  "hs_email_direction",
];

export interface ReplySweepResult {
  checked: number; // Meeting/Follow-Up'ta bakilan kart
  moved: number; //   In Progress'e tasinan (dry'da: tasinacak)
  quiet: number; //   demo sonrasi cevap yok -> yerinde birakildi
  skipped: number; // demo tarihi bilinmiyor -> dokunulmadi
  errors: number;
  /** "[Sales] Acme: Follow-Up -> In Progress (cevap: ali@acme.com, 22.09)" */
  items: string[];
}

export async function sweepRepliedDeals(
  opts: { dry?: boolean; max?: number } = {},
): Promise<ReplySweepResult> {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN tanimli degil");
  const dry = !!opts.dry;
  const max = Math.min(Math.max(opts.max ?? 400, 1), 2000);
  const r: ReplySweepResult = {
    checked: 0,
    moved: 0,
    quiet: 0,
    skipped: 0,
    errors: 0,
    items: [],
  };
  const note = (line: string): void => {
    if (r.items.length < 200) r.items.push(line);
  };

  // 1) Aday kartlar: Sales pipeline, Meeting veya Follow-Up.
  const deals: { id: string; props: Record<string, any> }[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20 && deals.length < max; page++) {
    const json = await hs.hsFetch<{ results?: any[]; paging?: any }>(
      "/crm/v3/objects/deals/search",
      {
        method: "POST",
        body: {
          filterGroups: [
            {
              filters: [
                { propertyName: "pipeline", operator: "EQ", value: PIPELINE_ID },
                { propertyName: "dealstage", operator: "IN", values: REPLY_FROM_STAGES },
              ],
            },
          ],
          properties: ["dealname", "dealstage", "ff_last_meeting_date", "createdate"],
          limit: 100,
          ...(after ? { after } : {}),
        },
      },
    );
    for (const d of json.results || []) {
      deals.push({ id: String(d.id), props: d.properties || {} });
    }
    after = json.paging?.next?.after;
    if (!after) break;
  }

  // 2) TOPLU: kart -> e-posta engagement id'leri.
  const assoc = await hs.batchReadAssociations(
    "deal",
    "email",
    deals.map((d) => d.id),
  );

  // 3) TOPLU: e-posta engagement'larini oku (tekilleştirilmiş id listesi).
  const emailIds = Array.from(new Set(Object.values(assoc).flat()));
  const emails = await hs.batchReadObjects("email", emailIds, EMAIL_PROPS);

  // 4) Karar + tasima.
  for (const d of deals) {
    r.checked++;
    const name = String(d.props.dealname || "").trim() || d.id;
    const fromStage = String(d.props.dealstage || "");
    try {
      const since = demoMs(d.props);
      if (since == null) {
        r.skipped++;
        continue; // demo tarihi bilinmiyor -> dokunma
      }
      const mine = (assoc[d.id] || []).map((id) => emails[id]).filter(Boolean);
      const hit = findReply(
        mine.map((p) => ({
          from: p.hs_email_from_email,
          subject: p.hs_email_subject,
          timestamp: p.hs_timestamp,
        })),
        since,
      );
      if (!hit) {
        r.quiet++;
        continue;
      }
      if (!dry) {
        await hs.updateObject("deal", d.id, {
          pipeline: PIPELINE_ID,
          dealstage: REPLY_TO_STAGE,
        });
      }
      r.moved++;
      const label = fromStage === STAGE.meeting ? "Meeting" : "Follow-Up";
      const when = new Date(hit.ms).toISOString().slice(0, 10);
      note(`[Sales] ${name}: ${label} -> In Progress (cevap: ${hit.from}, ${when})`);
    } catch (e: any) {
      r.errors++;
      note(`HATA [Sales] ${name}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  return r;
}
