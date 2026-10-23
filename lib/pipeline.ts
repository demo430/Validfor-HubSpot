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
  // sirket domain'i yok. Calendly form cevabini takvim etkinliginin
  // aciklamasina yazdigi icin ("Company Name: My Big Calling") beyan edilen ad
  // oradan okunur.
  //
  // Takvimdeki ad, Claude'un transkriptten cikardigi ada TERCIH EDILIR.
  // Eskiden kosul `!x.companyName` idi: Claude bir ad uretince takvim hic
  // okunmuyordu. Claude kurumsal domain yokken sirket yerine KISIYI yaziyor
  // ("Suruchi Mullick (Independent Consultant)", "Sarepta Therapeutics /
  // Solstice (via independent consultant)") — o ad hicbir karta denk gelmedigi
  // icin upsert YENI kart aciyor ve calendar-demos'un beyan edilen adla actigi
  // kart Unassigned'da bos kaliyor. Portalda dogrulandi (2026-10-14 demosu:
  // "My Big Calling" karti bos kaldi, yaninda ikiz kart acildi).
  //
  // Kurumsal domain VARSA takvime bakilmaz: domain zaten saglam kimliktir ve
  // kart adi kurali (beyan edilen ad > domain) calendar-demos tarafinda isler.
  const externals = externalEmails(t);
  const hasCompanyDomain = externals.some((e) => isCompanyDomain(emailDomain(e)));
  if (externals.length && !hasCompanyDomain) {
    try {
      const fromCalendar = await findCalendarCompanyName(externals, meetingDateMs(t));
      if (fromCalendar && fromCalendar !== x.companyName) {
        if (x.companyName) {
          console.log(
            `[pipeline] ${t.id}: webmail — beyan edilen ad Claude'un adini EZIYOR ` +
              `("${x.companyName}" -> "${fromCalendar}")`,
          );
        } else {
          console.log(`[pipeline] ${t.id}: sirket adi takvimden alindi -> ${fromCalendar}`);
        }
        x.companyName = fromCalendar;
      }
    } catch (e: any) {
      // Takvim okunamazsa Claude'un adina duseriz; pipeline kirilmaz.
      console.error("[pipeline] takvimden sirket adi alinamadi:", e?.message || e);
    }
  }

  return upsertMeeting(t, x);
}
