import { loadEnv } from "../lib/env.js";
import { app } from "../src/index.js";

// CANLI entegrasyon testi: gercek Fireflies webhook govdesini uygulamaya POST
// eder; route fetch -> classify -> upsert zincirini senkron calistirir.
// (Idempotent — Amplelogics zaten yazildiysa status=updated.)
// Kullanim: npm run test-webhook <transcriptId>
loadEnv();

async function main(): Promise<void> {
  const id = process.argv[2] || process.env.TEST_TRANSCRIPT_ID;
  if (!id) {
    console.error("Kullanim: npm run test-webhook <transcriptId>");
    process.exit(1);
  }
  const payload = JSON.stringify({ meetingId: id, eventType: "Transcription completed" });
  console.log("POST /api/fireflies govdesi:", payload);

  const started = Date.now();
  const res = await app.fetch(
    new Request("http://localhost/api/fireflies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    }),
  );
  const ms = Date.now() - started;

  console.log(`\nHTTP ${res.status}  (${ms} ms)`);
  console.log(await res.text());
  if (res.status !== 200) process.exit(1);
  console.log("\nOK: Faz 6 webhook uctan uca calisti");
}

main().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
