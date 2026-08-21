// Cekirdek pipeline: bir transkript ID -> temiz HubSpot kaydi.
// Hem webhook (Faz 6) hem backfill (Faz 8) bunu cagirir.
import { fetchTranscript } from "./fireflies.js";
import { classifyMeeting } from "./classify.js";
import {
  upsertMeeting,
  emailDomain,
  isCompanyDomain,
  isInternalEmail,
  meetingDateMs,
  type UpsertResult,
} from "./upsert.js";
import { findCalendarCompanyName } from "./gcal.js";

/** Toplantinin Validfor-disi katilimci e-postalari (kucuk harf, tekil). */
function externalEmails(t: any): string[] {
  return Array.from(
    new Set(
      (t.meeting_attendees || [])
        .map((a: any) => String(a?.email || "").toLowerCase().trim())
        .filter(Boolean)
        .filter((e: string) => !isInternalEmail(e)),
    ),
  );
}

export async function processTranscript(transcriptId: string): Promise<UpsertResult> {
  const t = await fetchTranscript(transcriptId); // ID normalize iceride
  const x = await classifyMeeting(t);

  // Serbest webmail kurtarmasi: karsi taraf gmail/icloud/hotmail kullaniyorsa
  // sirket domain'i yok; transkriptte de sirket adi gecmediyse upsert kaydi
  // ATLIYOR ve dolu bir demo CRM'e hic girmiyordu. Calendly form cevabi takvim
  // etkinliginin aciklamasinda duruyor — oradan okuyup akisa geri veriyoruz.
  const externals = externalEmails(t);
  const hasCompanyDomain = externals.some((e) => isCompanyDomain(emailDomain(e)));
  if (!x.companyName && externals.length && !hasCompanyDomain) {
    try {
      const fromCalendar = await findCalendarCompanyName(externals, meetingDateMs(t));
      if (fromCalendar) {
        x.companyName = fromCalendar;
        console.log(`[pipeline] ${t.id}: sirket adi takvimden alindi -> ${fromCalendar}`);
      }
    } catch (e: any) {
      // Takvim okunamazsa eski davranisa duseriz; kayit atlanir ama pipeline kirilmaz.
      console.error("[pipeline] takvimden sirket adi alinamadi:", e?.message || e);
    }
  }

  return upsertMeeting(t, x);
}
