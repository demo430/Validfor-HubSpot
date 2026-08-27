// Gecmise donuk e-posta yedeklemesi: ekip posta kutularindaki eski
// yazismalari HubSpot'a Email engagement olarak dusurur.
//
// NEDEN: HubSpot eklentisi yalniz ILERIYE donuk loglar; gelen kutusu
// baglamak da gecmisi ICERI ALMAZ. Bu yuzden CRM'de aylardir suren bir
// yazismanin hicbir izi olmuyor.
//
// AKIS:
//   1. Aktif deal'larin bagli sirketlerinden DOMAIN listesi cikarilir
//      (kapali/kayip/no-show stage'leri haric — etiketten canli cozulur).
//   2. Her posta kutusunda her domain icin Gmail aramasi yapilir.
//   3. Eslesen her mesaj HubSpot'a email engagement olarak yazilir ve
//      sirket + deal (+ varsa contact) ile iliskilendirilir.
//
// TEKILLESTIRME: mesajin RFC822 Message-ID'si `gmail_message_id` ozel
// alaninda tutulur; kosum basinda mevcut ID'ler tek seferde okunup Set'e
// alinir, damgali mesaj bir daha yazilmaz. Ucu tekrar tekrar cagirmak
// guvenlidir.
import * as hs from "./hubspot.js";
import * as gmail from "./gmail.js";
import { emailDomain, isCompanyDomain, isInternalEmail } from "./upsert.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Bu stage'lerdeki kartlar "aktif" sayilmaz. Etikete gore, ID'ye gore DEGIL:
 *  Sales Pipeline varsayilan stage ID'leri yeniden ADLANDIRILMIS durumda
 *  (`closedwon` -> "Follow-Up"), o yuzden ID'ye guvenilmez. */
const DEAD_STAGE_LABEL = /(^|\s)(lost|no ?show|not priority|churn)/i;

export interface EmailBackfillResult {
  mailboxes: string[];
  /** Taranan sirket domain'i sayisi. */
  domains: number;
  /** Gmail'de bulunan mesaj sayisi. */
  found: number;
  /** HubSpot'a yazilan (dry ise: yazilacak) mesaj sayisi. */
  logged: number;
  /** Zaten damgali oldugu icin atlanan. */
  duplicate: number;
  errors: number;
  /** false ise ayni URL tekrar cagrilmali. */
  done: boolean;
  /** Ilk 50 ornek: "mailbox | domain | tarih | konu". */
  items: string[];
  /** Gmail'e hic ulasilamadiysa sebep (delegasyon kurulmamis vb.). */
  gmailError?: string;
}

/** Stage ID -> etiket haritasi (iki pipeline icin de). */
async function stageLabels(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const json = await hs.hsFetch<{ results?: any[] }>("/crm/v3/pipelines/deals");
  for (const pipeline of json.results || []) {
    for (const stage of pipeline?.stages || []) {
      if (stage?.id) map.set(String(stage.id), String(stage.label || ""));
    }
  }
  return map;
}

export interface ActiveTarget {
  domain: string;
  companyId: string;
  dealIds: string[];
}

/** Aktif deal'larin bagli sirket domain'lerini toplar. */
export async function activeTargets(): Promise<ActiveTarget[]> {
  const labels = await stageLabels();
  const byDomain = new Map<string, ActiveTarget>();

  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const body: any = {
      filterGroups: [],
      properties: ["dealname", "dealstage", "pipeline"],
      limit: 100,
    };
    if (after) body.after = after;
    const json = await hs.hsFetch<{ results?: any[]; paging?: any }>(
      "/crm/v3/objects/deals/search",
      { method: "POST", body },
    );
    const results = json.results || [];
    if (!results.length) break;

    for (const deal of results) {
      const label = labels.get(String(deal?.properties?.dealstage || "")) || "";
      if (DEAD_STAGE_LABEL.test(label)) continue; // kapali/kayip kart
      const dealId = String(deal.id);
      let companyIds: string[] = [];
      try {
        companyIds = await hs.getAssociations("deal", dealId, "company");
      } catch {
        continue; // iliski okunamadi -> bu karti atla, kosumu bozma
      }
      for (const companyId of companyIds) {
        let company: any;
        try {
          company = await hs.getObject("company", companyId, ["domain", "name"]);
        } catch {
          continue;
        }
        const domain = String(company?.properties?.domain || "").toLowerCase().trim();
        if (!domain || !isCompanyDomain(domain)) continue; // webmail asla
        const existing = byDomain.get(domain);
        if (existing) {
          if (!existing.dealIds.includes(dealId)) existing.dealIds.push(dealId);
        } else {
          byDomain.set(domain, { domain, companyId, dealIds: [dealId] });
        }
      }
      await sleep(120); // HubSpot 4 istek/sn freni
    }

    after = json.paging?.next?.after;
    if (!after) break;
  }
  return [...byDomain.values()];
}

/** Daha once yazilmis Gmail mesaj ID'leri (tekillestirme icin). */
async function loggedMessageIds(): Promise<Set<string>> {
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const body: any = {
      filterGroups: [
        { filters: [{ propertyName: "gmail_message_id", operator: "HAS_PROPERTY" }] },
      ],
      properties: ["gmail_message_id"],
      limit: 100,
    };
    if (after) body.after = after;
    let json: { results?: any[]; paging?: any };
    try {
      json = await hs.hsFetch("/crm/v3/objects/emails/search", { method: "POST", body });
    } catch {
      break; // alan henuz yoksa (ilk kosum) bos Set ile devam
    }
    for (const row of json.results || []) {
      const id = String(row?.properties?.gmail_message_id || "");
      if (id) seen.add(id);
    }
    after = json.paging?.next?.after;
    if (!after) break;
    await sleep(300);
  }
  return seen;
}

/** `gmail_message_id` ozel alanini garanti eder (varsa dokunmaz). */
async function ensureMessageIdProperty(): Promise<void> {
  try {
    await hs.createProperty("emails", {
      name: "gmail_message_id",
      label: "Gmail Message ID",
      type: "string",
      fieldType: "text",
      groupName: "email",
      description:
        "Gecmise donuk yedeklemede yazilan mesajin RFC822 Message-ID'si (tekillestirme).",
    } as any);
  } catch (e: any) {
    // createProperty 409'u zaten "exists" olarak yutuyor; buraya dusen gercek
    // bir hatadir. Kosumu kesmiyoruz — yazma asamasi zaten patlar ve raporlanir.
    console.error("[email-backfill] gmail_message_id alani:", e?.message || e);
  }
}

export async function backfillEmails(
  opts: { dry?: boolean; months?: number; max?: number; budgetMs?: number } = {},
): Promise<EmailBackfillResult> {
  const dry = Boolean(opts.dry);
  const months = Math.min(Math.max(opts.months ?? 12, 1), 60);
  const max = Math.min(Math.max(opts.max ?? 100, 1), 400);
  const budgetMs = opts.budgetMs ?? 45_000;
  const startedAt = Date.now();
  const afterMs = Date.now() - months * 30 * 24 * 3600_000;

  const mailboxes = gmail.gmailMailboxes();
  const out: EmailBackfillResult = {
    mailboxes,
    domains: 0,
    found: 0,
    logged: 0,
    duplicate: 0,
    errors: 0,
    done: true,
    items: [],
  };

  if (!gmail.hasServiceAccount()) {
    out.gmailError = "GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY tanimli degil";
    out.errors++;
    return out;
  }
  if (!mailboxes.length) {
    out.gmailError =
      "Posta kutusu listesi bos — VALIDFOR_GMAIL_MAILBOXES ya da VALIDFOR_OWNER_MAP tanimlayin";
    out.errors++;
    return out;
  }

  let targets: ActiveTarget[];
  try {
    targets = await activeTargets();
  } catch (e: any) {
    console.error("[email-backfill] aktif kartlar okunamadi:", e?.message || e);
    out.errors++;
    out.done = false;
    return out;
  }
  out.domains = targets.length;
  if (!targets.length) return out;

  if (!dry) await ensureMessageIdProperty();
  const seen = await loggedMessageIds();

  for (const mailbox of mailboxes) {
    for (const target of targets) {
      if (Date.now() - startedAt > budgetMs || out.logged >= max) {
        out.done = false;
        return out;
      }
      let ids: string[];
      try {
        ids = await gmail.searchMessageIds(
          mailbox,
          gmail.domainQuery(target.domain, afterMs),
          Math.min(max - out.logged, 50),
        );
      } catch (e: any) {
        const msg = String(e?.message || e);
        // Delegasyon hic kurulmamissa her kutuda ayni hata gelir — bir kez
        // raporla ve kosumu bitir, 6 kutu x 40 domain bosuna denenmesin.
        if (/delegasyonu yok/i.test(msg)) {
          out.gmailError = msg;
          out.errors++;
          out.done = false;
          return out;
        }
        console.error(`[email-backfill] ${mailbox} ${target.domain}:`, msg);
        out.errors++;
        continue;
      }
      out.found += ids.length;

      for (const id of ids) {
        if (Date.now() - startedAt > budgetMs || out.logged >= max) {
          out.done = false;
          return out;
        }
        let msg: gmail.GmailMessage;
        try {
          msg = await gmail.getMessage(mailbox, id);
        } catch (e: any) {
          console.error(`[email-backfill] mesaj okunamadi ${id}:`, e?.message || e);
          out.errors++;
          continue;
        }
        const key = msg.rfcId || `gmail:${msg.id}`;
        if (seen.has(key)) {
          out.duplicate++;
          continue;
        }
        seen.add(key); // ayni mesaj birden fazla kutuda/domainde cikabilir

        out.logged++;
        if (out.items.length < 50) {
          out.items.push(
            `${mailbox} | ${target.domain} | ${new Date(msg.dateMs)
              .toISOString()
              .slice(0, 10)} | ${msg.subject.slice(0, 60)}`,
          );
        }
        if (dry) continue;

        try {
          await writeEmail(msg, key, target);
        } catch (e: any) {
          console.error(`[email-backfill] yazilamadi ${key}:`, e?.message || e);
          out.errors++;
          out.logged--;
        }
        await sleep(350); // HubSpot 4 istek/sn freni
      }
    }
  }
  return out;
}

/** Tek mesaji HubSpot'a email engagement olarak yazar ve iliskilendirir. */
async function writeEmail(
  msg: gmail.GmailMessage,
  key: string,
  target: ActiveTarget,
): Promise<void> {
  // Yon: gonderen ic biriyse giden, degilse gelen.
  const outgoing = isInternalEmail(msg.from);
  const created = await hs.createObject("email", {
    hs_timestamp: msg.dateMs,
    hs_email_direction: outgoing ? "EMAIL" : "INCOMING_EMAIL",
    hs_email_status: "SENT",
    hs_email_subject: msg.subject || "(konu yok)",
    hs_email_text:
      `From: ${msg.from}\nTo: ${msg.to.join(", ")}` +
      (msg.cc.length ? `\nCc: ${msg.cc.join(", ")}` : "") +
      `\n\n${msg.body}`,
    gmail_message_id: key,
  });
  const emailId = String((created as any)?.id || "");
  if (!emailId) throw new Error("email engagement id bos dondu");

  await hs.associateDefault("email", emailId, "company", target.companyId);
  for (const dealId of target.dealIds) {
    await hs.associateDefault("email", emailId, "deal", dealId);
  }
  // Karsi taraftaki kisiyi de bagla (varsa) — kart uzerinde kimle
  // yazisildigi gorunsun.
  const external = [msg.from, ...msg.to, ...msg.cc].find(
    (e) => e && emailDomain(e) === target.domain,
  );
  if (external) {
    try {
      const contact = await hs.searchByProperty("contact", "email", "EQ", external, ["email"]);
      if (contact?.id) await hs.associateDefault("email", emailId, "contact", String(contact.id));
    } catch {
      // contact bulunamadi/okunamadi -> e-posta yine de sirket+deal'da duruyor
    }
  }
}
