// Cekirdek pipeline: bir transkript ID -> temiz HubSpot kaydi.
// Hem webhook (Faz 6) hem backfill (Faz 8) bunu cagirir.
import { fetchTranscript } from "./fireflies.js";
import { classifyMeeting } from "./classify.js";
import { upsertMeeting, type UpsertResult } from "./upsert.js";

export async function processTranscript(transcriptId: string): Promise<UpsertResult> {
  const t = await fetchTranscript(transcriptId); // ID normalize iceride
  const x = await classifyMeeting(t);
  return upsertMeeting(t, x);
}
