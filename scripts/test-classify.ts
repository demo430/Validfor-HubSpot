import { loadEnv } from "../lib/env.js";
import { fetchTranscript } from "../lib/fireflies.js";
import { classifyMeeting } from "../lib/classify.js";

// Canli test: gercek transkripti ceker, Claude (Sonnet 5) ile siniflandirir.
// Kullanim: npm run test-classify <transcriptId>
loadEnv();

async function main(): Promise<void> {
  const id = process.argv[2] || process.env.TEST_TRANSCRIPT_ID;
  if (!id) {
    console.error("Kullanim: npm run test-classify <transcriptId>");
    process.exit(1);
  }
  const t = await fetchTranscript(id);
  console.log(`Transkript: "${t.title}" (${(t.sentences || []).length} cumle)\n`);

  const started = Date.now();
  const x = await classifyMeeting(t);
  const ms = Date.now() - started;

  console.log("companyName :", x.companyName);
  console.log("meetingType :", x.meetingType);
  console.log("summary     :", x.summary);
  console.log("nextSteps   :");
  for (const s of x.nextSteps) console.log("  -", s);
  console.log(`\nOK: Faz 4 classify calisti (${ms} ms)`);
}

main().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
