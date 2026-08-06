import { loadEnv } from "../lib/env.js";
import { fetchTranscript, viewUrl } from "../lib/fireflies.js";

// Canli test: gercek bir transkripti ceker ve ozetini yazdirir.
// Kullanim: npm run test-fireflies <transcriptId>
//   (veya .env.local'de TEST_TRANSCRIPT_ID). FIREFLIES_API_KEY gerekir.
loadEnv();

async function main(): Promise<void> {
  const id = process.argv[2] || process.env.TEST_TRANSCRIPT_ID;
  if (!id) {
    console.error(
      "Kullanim: npm run test-fireflies <transcriptId>  (veya .env.local TEST_TRANSCRIPT_ID)",
    );
    process.exit(1);
  }
  const t = await fetchTranscript(id);
  const emails = (t.meeting_attendees || [])
    .map((a) => a.email)
    .filter(Boolean);
  console.log("id             :", t.id);
  console.log("title          :", t.title);
  console.log("dateString     :", t.dateString);
  console.log("duration (min) :", t.duration);
  console.log("attendees      :", (t.meeting_attendees || []).length, emails.slice(0, 6));
  console.log("speakers       :", (t.speakers || []).map((s) => s.name).slice(0, 8));
  console.log("sentences      :", (t.sentences || []).length);
  console.log("summary present:", Boolean(t.summary));
  console.log("overview       :", String(t.summary?.overview || "").slice(0, 240));
  console.log("fireflies_link :", viewUrl(t.id));
  console.log("\nOK: Faz 2 fetch calisti");
}

main().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
