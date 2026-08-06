import fs from "node:fs";
import { loadEnv } from "../lib/env.js";
import { fetchTranscript, viewUrl } from "../lib/fireflies.js";
import { buildTranscriptPDF } from "../lib/pdf.js";

// Canli test: gercek transkripti ceker, PDF uretir, diske yazar.
// Kullanim: npm run test-pdf <transcriptId> [ciktiYolu.pdf]
loadEnv();

async function main(): Promise<void> {
  const id = process.argv[2] || process.env.TEST_TRANSCRIPT_ID;
  if (!id) {
    console.error("Kullanim: npm run test-pdf <transcriptId> [ciktiYolu.pdf]");
    process.exit(1);
  }
  const t = await fetchTranscript(id);
  const pdf = await buildTranscriptPDF(t);
  const outPath = process.argv[3] || `transcript-${t.id}.pdf`;
  fs.writeFileSync(outPath, pdf);

  console.log("title    :", t.title);
  console.log("sentences:", (t.sentences || []).length);
  console.log("summary  :", Boolean(t.summary));
  console.log("PDF      :", pdf.length, "bytes ->", outPath);
  console.log("magic    :", pdf.subarray(0, 5).toString("latin1"));
  console.log("link     :", viewUrl(t.id));
  console.log("\nOK: Faz 3 PDF uretildi");
}

main().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
