// Faz 8: Trello backfill — out/trello-match.json'daki onayli eslesmeleri
// pipeline'dan gecirir (sirket + kisiler + deal + not/PDF + meeting engagement)
// ve deal stage'ini KARTIN TRELLO LISTESINDEN tasir (insan eliyle kurulmus
// board durumu > toplanti-sayisi otomasyonu).
//
// Idempotent: islenmis transkriptler on-taramayla atlanir (Claude cagrisi bile
// yapilmaz); stage yalnizca ILERI tasinir (pipeline sirasina gore, asla geri).
//
// Calistir:  npm run backfill-trello -- --dry          (yazmadan plani goster)
//            npm run backfill-trello                    (YUKSEK guvenliler)
//            npm run backfill-trello -- --confidence high,medium
//            npm run backfill-trello -- --limit 10
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "../lib/env.js";
import { processTranscript } from "../lib/pipeline.js";
import * as hs from "../lib/hubspot.js";
import { PIPELINE_ID } from "../lib/upsert.js";

loadEnv();

const JSON_PATH = path.join(process.cwd(), "out", "trello-match.json");
const RESULT_PATH = path.join(process.cwd(), "out", "backfill-result.json");

// !!! Bu esleme 2026-07 backfill'i sirasindaki ESKI pipeline yapisina gore
// yazildi (backfill tamamlandi). Pipeline yeniden yapilandirildi; yeniden
// kosulacaksa once bu tabloyu guncelle. main() basinda canli pipeline'dan
// stage dogrulamasi var: gecersiz hedefler YAZILMAZ, loglanip atlanir.
//
// Trello listesi -> Sales Pipeline stage (ic ID) + pipeline sirasi (displayOrder).
// Birebir karsiligi olmayan listeler en yakin stage'e esler:
//   Proposal Follow -> Proposal Sent, Paying Customer/Reference -> Won/Advanced
const LIST_TO_STAGE: Record<string, { id: string; order: number }> = {
  "1st Meeting / Demo": { id: "qualifiedtobuy", order: 1 },
  "2nd Meeting": { id: "presentationscheduled", order: 2 },
  "3rd Meeting": { id: "decisionmakerboughtin", order: 3 },
  "Demo Delivered": { id: "contractsent", order: 4 },
  "Follow": { id: "closedwon", order: 5 },
  "Proposal Sent": { id: "closedlost", order: 6 },
  "Proposal Follow": { id: "closedlost", order: 6 },
  "PoC": { id: "5706717428", order: 7 },
  "Paying Customer": { id: "5706717429", order: 8 },
  "Won/Advanced": { id: "5706717429", order: 8 },
  "Reference": { id: "5706717429", order: 8 },
  "Lost/Not Now": { id: "5706717430", order: 9 },
  "No show": { id: "5706717431", order: 10 },
};
const STAGE_ORDER: Record<string, number> = {
  appointmentscheduled: 0, qualifiedtobuy: 1, presentationscheduled: 2,
  decisionmakerboughtin: 3, contractsent: 4, closedwon: 5, closedlost: 6,
  "5706717428": 7, "5706717429": 8, "5706717430": 9, "5706717431": 10,
};

interface Row {
  cardId: string;
  cardName: string;
  cardList: string;
  transcriptId: string | null;
  transcriptTitle: string | null;
  confidence: string;
  rejected: boolean;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const confArg = /--confidence[= ]?([\w,]+)/.exec(args.join(" "))?.[1] || "high";
  const allowed = new Set(confArg.split(",").map((s) => s.trim()));
  const limit = Number(/--limit[= ]?(\d+)/.exec(args.join(" "))?.[1] || 0) || Infinity;

  const report = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  const rows: Row[] = (report.rows || []).filter(
    (r: Row) => r.transcriptId && !r.rejected && allowed.has(r.confidence),
  );

  // Guvenlik agi: LIST_TO_STAGE hedeflerini CANLI pipeline'a karsi dogrula.
  // (Pipeline yeniden yapilandirilirsa eski ID'ler gecersizlesir — yazma!)
  const pipes = await hs.hsFetch<{ results?: any[] }>("/crm/v3/pipelines/deals");
  const validStages = new Set<string>(
    (pipes.results || []).flatMap((p: any) => (p.stages || []).map((s: any) => String(s.id))),
  );
  for (const [list, tgt] of Object.entries(LIST_TO_STAGE)) {
    if (!validStages.has(tgt.id)) {
      console.error(
        `UYARI: "${list}" hedefi (${tgt.id}) artik pipeline'da YOK — bu liste icin stage yazilmayacak.`,
      );
      delete LIST_TO_STAGE[list];
    }
  }

  // Ayni transkripte birden cok kart olabilir (mukerrer kartlar) -> transkript
  // basina TEK isleme; hedef stage = kartlarin listelerinden EN ILERI olani.
  const byTranscript = new Map<string, { rows: Row[]; target: { id: string; order: number } | null }>();
  for (const r of rows) {
    const cur = byTranscript.get(r.transcriptId!) || { rows: [], target: null };
    cur.rows.push(r);
    const mapped = LIST_TO_STAGE[r.cardList] || null;
    if (mapped && (!cur.target || mapped.order > cur.target.order)) cur.target = mapped;
    byTranscript.set(r.transcriptId!, cur);
  }

  const work = Array.from(byTranscript.entries()).slice(0, limit);
  console.log(
    `${rows.length} kart -> ${byTranscript.size} benzersiz transkript; islenecek: ${work.length}` +
      (dry ? "  [KURU CALISTIRMA — hicbir sey yazilmaz]" : ""),
  );

  const results: any[] = [];
  let i = 0;
  for (const [tid, w] of work) {
    i++;
    const label = w.rows[0].cardName.slice(0, 44);
    try {
      // On-tarama: islenmisse pipeline'i (Claude dahil) tamamen atla.
      const notes = await hs.searchNotes({ contains: tid, limit: 1 });
      const processed = (notes.results || []).length > 0;

      let dealId = "";
      let status = "";
      if (processed) {
        const assoc = await hs.getNoteAssociations(String(notes.results[0].id));
        dealId = assoc.deals[0] || "";
        status = "zaten islenmis";
      } else if (dry) {
        status = "ISLENECEK (fetch+classify+upsert)";
      } else {
        const r = await processTranscript(tid);
        dealId = r.dealId || "";
        status = r.status;
      }

      // Stage override: kartin listesi -> stage (yalniz ILERI).
      let stageNote = "-";
      if (w.target && dealId) {
        const live = await hs.getObject("deal", dealId, ["dealstage"]);
        const cur = String(live?.properties?.dealstage || "");
        const curOrder = cur in STAGE_ORDER ? STAGE_ORDER[cur] : -1;
        if (w.target.order > curOrder) {
          if (!dry) {
            await hs.updateObject("deal", dealId, {
              pipeline: PIPELINE_ID,
              dealstage: w.target.id,
            });
          }
          stageNote = `${cur || "(bos)"} -> ${w.target.id} ("${w.rows.map((r) => r.cardList)[0]}")`;
        } else {
          stageNote = `korundu (${cur})`;
        }
      } else if (w.target && !dealId && dry) {
        stageNote = `hedef: ${w.target.id}`;
      }

      console.log(`[${String(i).padStart(2)}/${work.length}] ${label.padEnd(46)} ${status.padEnd(28)} stage: ${stageNote}`);
      results.push({ transcriptId: tid, cards: w.rows.map((r) => r.cardName), status, stage: stageNote, dealId });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 160);
      console.error(`[${String(i).padStart(2)}/${work.length}] ${label.padEnd(46)} HATA: ${msg}`);
      results.push({ transcriptId: tid, cards: w.rows.map((r) => r.cardName), status: "HATA", error: msg });
    }
  }

  if (!dry) {
    fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
    fs.writeFileSync(RESULT_PATH, JSON.stringify(results, null, 2));
    console.log(`\nSonuc: ${RESULT_PATH}`);
  }
  const ok = results.filter((r) => r.status !== "HATA").length;
  console.log(`\nBitti: ${ok}/${results.length} basarili, ${results.length - ok} hata`);
}

main().catch((e) => {
  console.error("HATA:", e?.message || e);
  process.exit(1);
});
