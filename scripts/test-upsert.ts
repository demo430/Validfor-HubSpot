import { loadEnv } from "../lib/env.js";
import { fetchTranscript } from "../lib/fireflies.js";
import { classifyMeeting } from "../lib/classify.js";
import { upsertMeeting } from "../lib/upsert.js";

// CANLI test: gercek toplantiyi HubSpot'a yazar (company + contacts + deal +
// not + PDF). Idempotent — tekrar calistirinca kopya olusturmaz.
// Kullanim: npm run test-upsert <transcriptId>
loadEnv();

async function main(): Promise<void> {
  const id = process.argv[2] || process.env.TEST_TRANSCRIPT_ID;
  if (!id) {
    console.error("Kullanim: npm run test-upsert <transcriptId>");
    process.exit(1);
  }
  console.log("1/3 Fireflies'tan transkript cekiliyor…");
  const t = await fetchTranscript(id);
  console.log(`     "${t.title}" (${(t.sentences || []).length} cumle)`);

  console.log("2/3 Claude (Sonnet 5) ile siniflandiriliyor…");
  const x = await classifyMeeting(t);
  console.log(`     company=${x.companyName} type=${x.meetingType}`);

  console.log("3/3 HubSpot'a yaziliyor (bul-olustur)…");
  const r = await upsertMeeting(t, x);

  console.log("\n=== SONUC ===");
  console.log("status     :", r.status, r.reason ? `(${r.reason})` : "");
  console.log("companyId  :", r.companyId);
  console.log("dealId     :", r.dealId);
  console.log("contactIds :", r.contactIds.join(", "));
  console.log("noteId     :", r.noteId);
  console.log("link       :", r.fireflies_link);
  console.log("\nOK: Faz 5 upsert calisti");
}

main().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
