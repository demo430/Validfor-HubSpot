import { loadEnv } from "../lib/env.js";
import { backfillCompanies } from "../lib/backfill.js";

// HubSpot'taki MEVCUT sirketleri Apollo organizations/enrich ile geriye donuk
// doldurur — cekirdek mantik lib/backfill.ts'te (endpoint'le ortak).
//
// Calistir (yerel):
//   npm run backfill-companies -- --dry        # yazmadan onizleme
//   npm run backfill-companies                 # gercek yazim
//   npm run backfill-companies -- --max=200    # Apollo'ya sorulacak sirket siniri
//
// Gerekli env: HUBSPOT_TOKEN + APOLLO_API_KEY (.env.local / ortam degiskeni).
// Not (Anthropic bulut ortami): NODE_USE_ENV_PROXY=1 ile calistir (README).
// Lokal kurulum yoksa ayni is deploy uzerinden: GET /api/backfill-companies

loadEnv();

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const maxArg = /^--max=(\d+)$/.exec(args.find((a) => a.startsWith("--max=")) || "");
const MAX = maxArg ? Number(maxArg[1]) : 1000;

async function main(): Promise<void> {
  console.log(
    `Sirket backfill basliyor (${DRY ? "DRY-RUN — yazilmayacak" : "CANLI"}, max=${MAX})`,
  );
  const r = await backfillCompanies({ maxEnrich: MAX, dry: DRY, itemLimit: 1000 });
  for (const line of r.items) console.log(`${DRY ? "[dry] " : ""}${line}`);
  console.log(
    `\nBitti. taranan=${r.scanned} dolduruldu=${r.filled}` +
      `${DRY ? " (dry — yazilmadi)" : ""} zaten-dolu=${r.alreadyFull} ` +
      `apollo-tanimadi=${r.notFound} yeni-veri-yok=${r.nothingNew} ` +
      `domainsiz=${r.noDomain} serbest-domain=${r.freeDomain} hata=${r.errors}`,
  );
  if (!r.done) {
    console.log("Not: sinira takildi — kalan icin tekrar calistir (yalniz bos alanlar dolar).");
  }
  process.exit(r.errors ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
