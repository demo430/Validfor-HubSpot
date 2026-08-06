// Faz 8 / Adim 1-2: Trello <-> Fireflies eslestirme KURU CALISTIRMA raporu.
// HubSpot'a DOKUNMAZ. Cikti: konsol tablosu + out/trello-match.json + PDF rapor.
// Belirsiz eslesmelerde (skorlar yakin) Claude hakemligi (tek toplu cagri).
//
// Calistir:  npm run match-trello              (tam kosum)
//            npm run match-trello -- --pdf-only (JSON'dan yalnizca PDF'i yeniden uret)
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "../lib/env.js";
import { fetchBoardCards } from "../lib/trello.js";
import { fetchTranscriptList } from "../lib/fireflies.js";
import { matchCards, type CardMatch } from "../lib/match.js";
import { regular as FONT_REGULAR, bold as FONT_BOLD } from "../lib/fonts.js";

loadEnv();

const OUT_DIR = path.join(process.cwd(), "out");
const JSON_PATH = path.join(OUT_DIR, "trello-match.json");
const PDF_PATH = path.join(OUT_DIR, "trello-match-report.pdf");

// Duzlestirilmis rapor satiri — hem JSON'a yazilir hem PDF bundan cizilir.
// (Backfill scripti de bu JSON'u okuyacak.)
interface ReportRow {
  cardId: string;
  cardName: string;
  cardList: string;
  cardUrl: string;
  cardDue: string | null;
  transcriptId: string | null;
  transcriptTitle: string | null;
  transcriptDate: string | null;
  score: number;
  confidence: "high" | "medium" | "low" | "none";
  ambiguous: boolean;
  reasons: string[];
  claudeVerdict: string | null;
  /** Claude hakemligi heuristik eslesmeyi reddetti. */
  rejected: boolean;
}

interface Report {
  boardName: string;
  generatedAt: string;
  rows: ReportRow[];
}

// --- Claude hakemligi: belirsiz kartlar icin tek toplu cagri ---
async function adjudicate(
  matches: CardMatch[],
): Promise<Map<string, { transcriptId: string | null; reason: string }>> {
  const out = new Map<string, { transcriptId: string | null; reason: string }>();
  const ambiguous = matches.filter((m) => m.ambiguous && m.best);
  if (!ambiguous.length || !process.env.ANTHROPIC_API_KEY) return out;

  const items = ambiguous.map((m) => ({
    cardId: m.card.id,
    cardName: m.card.name,
    cardDesc: m.card.desc.slice(0, 300),
    cardList: m.card.listName,
    cardDue: m.card.due,
    candidates: [m.best!, ...(m.runnerUp ? [m.runnerUp] : [])].map((c) => ({
      transcriptId: c.t.id,
      title: c.t.title,
      date: c.t.dateMs ? new Date(c.t.dateMs).toISOString().slice(0, 10) : null,
      attendees: c.t.attendeeEmails.slice(0, 6),
      score: c.score,
    })),
  }));

  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            cardId: { type: "string" },
            transcriptId: {
              type: ["string", "null"],
              description: "Best matching transcript id, or null if none truly matches.",
            },
            reason: { type: "string" },
          },
          required: ["cardId", "transcriptId", "reason"],
        },
      },
    },
    required: ["decisions"],
  };

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 60_000,
    maxRetries: 1,
  });
  const res = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 3000,
    thinking: { type: "disabled" },
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content:
          `You match Trello demo cards to Fireflies meeting transcripts. ` +
          `For each item pick the candidate transcript that truly corresponds to the card ` +
          `(same company/person/meeting), or null if none does. Be conservative.\n\n` +
          JSON.stringify(items, null, 2),
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const block = res.content.find((b) => b.type === "text");
  try {
    const parsed = JSON.parse(block && "text" in block ? block.text : "{}");
    for (const d of parsed.decisions || []) {
      out.set(String(d.cardId), {
        transcriptId: d.transcriptId || null,
        reason: String(d.reason || ""),
      });
    }
  } catch {
    console.error("Claude hakem yaniti parse edilemedi — heuristik sonuclar kullanilacak");
  }
  return out;
}

// ============================== PDF RAPOR ==============================
// Renkler: CVD-guvenli uclu (dataviz dogrulayicisindan gecti) + notr gri.
// Kimlik ASLA yalniz renkle tasinmaz: her renk yaninda etiket + sayi var.
const INK = "#1f2328"; // ana metin
const MUTED = "#6e7781"; // ikincil metin
const FAINT = "#d8dee4"; // cizgiler
const ZEBRA = "#f6f8fa"; // satir arkaplani
const LINK = "#0969da";
const BAND = "#24292f"; // baslik bandi
const CONF = {
  high: { color: "#0969da", label: "YÜKSEK" },
  medium: { color: "#c08a00", label: "ORTA" },
  low: { color: "#d03b3b", label: "DÜŞÜK" },
  none: { color: "#8b949e", label: "KAYIT YOK" },
} as const;

const A4W = 595.28;
const A4H = 841.89;
const M = 46; // kenar boslugu
const CW = A4W - 2 * M; // icerik genisligi
const FOOTER_Y = A4H - 34;
const BOTTOM = FOOTER_Y - 12;

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "?";
}

function buildReportPDF(report: Report): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: M,
      bufferPages: true,
      font: false,
      info: { Title: "Trello ↔ Fireflies Eşleştirme Raporu" },
    } as unknown as PDFKit.PDFDocumentOptions);
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont("body", FONT_REGULAR);
    doc.registerFont("bold", FONT_BOLD);

    const rows = report.rows;
    const groups = {
      high: rows.filter((r) => r.confidence === "high" && !r.rejected),
      medium: rows.filter((r) => r.confidence === "medium" && !r.rejected),
      low: rows.filter((r) => r.confidence === "low" && !r.rejected),
      rejected: rows.filter((r) => r.rejected),
      none: rows.filter((r) => r.confidence === "none" && !r.rejected),
    };

    const ensure = (h: number): void => {
      if (doc.y + h > BOTTOM) {
        doc.addPage();
        doc.y = M;
      }
    };

    // ---------- Baslik bandi ----------
    doc.rect(0, 0, A4W, 96).fill(BAND);
    doc.font("bold").fontSize(19).fillColor("#ffffff")
      .text("Trello ↔ Fireflies Eşleştirme Raporu", M, 28, { width: CW });
    doc.font("body").fontSize(9).fillColor("#aeb8c2")
      .text(
        `Board "${report.boardName}"  ·  ${rows.length} kart tarandı  ·  ${report.generatedAt}`,
        M, 58, { width: CW },
      );
    doc.y = 116;

    // ---------- Ozet kutulari ----------
    const tiles: Array<{ key: keyof typeof CONF; n: number; sub: string }> = [
      { key: "high", n: groups.high.length, sub: "backfill'e hazır" },
      { key: "medium", n: groups.medium.length, sub: "incele + onayla" },
      { key: "low", n: groups.low.length, sub: "muhtemelen yanlış" },
      { key: "none", n: groups.none.length + groups.rejected.length, sub: "Fireflies kaydı yok" },
    ];
    const gap = 10;
    const tw = (CW - 3 * gap) / 4;
    const th = 58;
    const ty = doc.y;
    tiles.forEach((t, i) => {
      const x = M + i * (tw + gap);
      doc.roundedRect(x, ty, tw, th, 8).fillAndStroke(ZEBRA, FAINT);
      doc.roundedRect(x + 10, ty + 11, 7, 7, 2).fill(CONF[t.key].color);
      doc.font("bold").fontSize(7.5).fillColor(MUTED)
        .text(CONF[t.key].label, x + 22, ty + 11, { width: tw - 30, lineBreak: false });
      doc.font("bold").fontSize(19).fillColor(INK)
        .text(String(t.n), x + 10, ty + 23, { lineBreak: false });
      doc.font("body").fontSize(7).fillColor(MUTED)
        .text(t.sub, x + 10, ty + 44, { width: tw - 20, lineBreak: false });
    });
    doc.y = ty + th + 14;

    // ---------- Dagilim cubugu ----------
    const total = rows.length || 1;
    const segs = [
      { n: groups.high.length, color: CONF.high.color, label: CONF.high.label },
      { n: groups.medium.length, color: CONF.medium.color, label: CONF.medium.label },
      { n: groups.low.length, color: CONF.low.color, label: CONF.low.label },
      { n: groups.none.length + groups.rejected.length, color: CONF.none.color, label: CONF.none.label },
    ].filter((s) => s.n > 0);
    const barY = doc.y;
    const barH = 12;
    doc.save();
    doc.roundedRect(M, barY, CW, barH, 6).clip();
    let bx = M;
    for (const s of segs) {
      const w = (s.n / total) * CW;
      doc.rect(bx, barY, Math.max(w - 2, 2), barH).fill(s.color); // 2pt beyaz ayirici
      bx += w;
    }
    doc.restore();
    // Cubuk lejanti — kimlik renk + ETIKET + sayi (asla yalniz renk)
    let lx = M;
    const ly = barY + barH + 7;
    doc.font("body").fontSize(8);
    for (const s of segs) {
      doc.roundedRect(lx, ly + 1.5, 6, 6, 1.5).fill(s.color);
      const txt = `${s.label} ${s.n} (%${Math.round((s.n / total) * 100)})`;
      doc.fillColor(MUTED).text(txt, lx + 10, ly, { lineBreak: false });
      lx += 10 + doc.widthOfString(txt) + 16;
    }
    doc.y = ly + 22;

    // ---------- Bolum ciziciler ----------
    const sectionHeader = (title: string, count: number, color: string): void => {
      ensure(46);
      const y = doc.y + 6;
      doc.rect(M, y + 1, 3.5, 13).fill(color);
      doc.font("bold").fontSize(12.5);
      const titleW = doc.widthOfString(title); // DOGRU fontla olc (cakisma olmasin)
      doc.fillColor(INK).text(title, M + 11, y, { lineBreak: false });
      doc.font("body").fontSize(9).fillColor(MUTED)
        .text(`·  ${count} kart`, M + 11 + titleW + 8, y + 3, { lineBreak: false });
      doc.moveTo(M, y + 20).lineTo(M + CW, y + 20).lineWidth(0.7).stroke(FAINT);
      doc.y = y + 28;
    };

    const PAD = 9;
    const IW = CW - 2 * PAD; // satir ici metin genisligi

    // Eslesen kart satiri (zebra + skor rozeti)
    const matchRow = (r: ReportRow, zebra: boolean): void => {
      doc.font("bold").fontSize(9.8);
      const nameH = doc.heightOfString(r.cardName, { width: IW - 62 });
      doc.font("body").fontSize(7.8);
      const meta = `Liste: ${r.cardList}${r.cardDue ? `  ·  Due: ${fmtDate(r.cardDue)}` : ""}`;
      const metaH = doc.heightOfString(meta, { width: IW });
      doc.font("body").fontSize(9);
      const matchLine = `→  ${r.transcriptTitle}  —  ${fmtDate(r.transcriptDate)}`;
      const matchH = doc.heightOfString(matchLine, { width: IW });
      doc.fontSize(7.8);
      const reasonTxt = r.reasons.length ? `Gerekçe: ${r.reasons.join("; ")}` : "";
      const reasonH = reasonTxt ? doc.heightOfString(reasonTxt, { width: IW }) : 0;
      const verdictTxt =
        r.claudeVerdict && !r.rejected ? `Claude hakem onayı: ${r.claudeVerdict}` : "";
      const verdictH = verdictTxt ? doc.heightOfString(verdictTxt, { width: IW }) : 0;
      const link = r.transcriptId ? `app.fireflies.ai/view/${r.transcriptId}` : "";
      const linkH = link ? 10 : 0;

      const H = PAD + nameH + 2 + metaH + 4 + matchH + (reasonH ? 2 + reasonH : 0) +
        (verdictH ? 2 + verdictH : 0) + (linkH ? 2 + linkH : 0) + PAD;
      ensure(H + 4);
      const y0 = doc.y;
      if (zebra) doc.roundedRect(M, y0, CW, H, 6).fill(ZEBRA);

      // skor rozeti (sag ust)
      doc.font("body").fontSize(7.5);
      const badge = `skor ${r.score}`;
      const bw = doc.widthOfString(badge) + 12;
      doc.roundedRect(M + CW - PAD - bw, y0 + PAD - 1.5, bw, 13, 6.5)
        .fillAndStroke(zebra ? "#ffffff" : ZEBRA, FAINT);
      doc.fillColor(MUTED).text(badge, M + CW - PAD - bw + 6, y0 + PAD + 1, {
        lineBreak: false,
      });

      let y = y0 + PAD;
      doc.font("bold").fontSize(9.8).fillColor(INK)
        .text(r.cardName, M + PAD, y, { width: IW - 62 });
      y += nameH + 2;
      doc.font("body").fontSize(7.8).fillColor(MUTED)
        .text(meta, M + PAD, y, { width: IW });
      y += metaH + 4;
      doc.font("body").fontSize(9).fillColor(INK)
        .text(matchLine, M + PAD, y, { width: IW });
      y += matchH;
      if (reasonTxt) {
        y += 2;
        doc.fontSize(7.8).fillColor(MUTED).text(reasonTxt, M + PAD, y, { width: IW });
        y += reasonH;
      }
      if (verdictTxt) {
        y += 2;
        doc.fontSize(7.8).fillColor(MUTED).text(verdictTxt, M + PAD, y, { width: IW });
        y += verdictH;
      }
      if (link) {
        y += 2;
        doc.fontSize(7.8).fillColor(LINK).text(link, M + PAD, y, { lineBreak: false });
      }
      doc.y = y0 + H + 4;
    };

    for (const [key, title] of [
      ["high", "Yüksek güvenli eşleşmeler"],
      ["medium", "Orta güvenli eşleşmeler"],
      ["low", "Düşük güvenli eşleşmeler"],
    ] as const) {
      const list = groups[key];
      if (!list.length) continue;
      sectionHeader(title, list.length, CONF[key].color);
      list.forEach((r, i) => matchRow(r, i % 2 === 0));
      doc.y += 6;
    }

    // Claude hakem retleri — nicin reddedildigi incelemede degerli
    if (groups.rejected.length) {
      sectionHeader("Claude hakemliğinde reddedilenler", groups.rejected.length, CONF.none.color);
      doc.font("body").fontSize(7.8).fillColor(MUTED).text(
        "Skorlar yakındı; Claude aday transkriptleri kartla karşılaştırıp eşleşme olmadığına karar verdi.",
        M, doc.y, { width: CW },
      );
      doc.y += 6;
      groups.rejected.forEach((r, i) => {
        doc.font("bold").fontSize(9);
        const nameH = doc.heightOfString(r.cardName, { width: IW });
        doc.font("body").fontSize(7.8);
        const why = `Claude: ${r.claudeVerdict || "eşleşme reddedildi"}`;
        const whyH = doc.heightOfString(why, { width: IW });
        const H = 7 + nameH + 2 + whyH + 7;
        ensure(H + 3);
        const y0 = doc.y;
        if (i % 2 === 0) doc.roundedRect(M, y0, CW, H, 6).fill(ZEBRA);
        doc.font("bold").fontSize(9).fillColor(INK)
          .text(r.cardName, M + PAD, y0 + 7, { width: IW });
        doc.font("body").fontSize(7.8).fillColor(MUTED)
          .text(why, M + PAD, y0 + 7 + nameH + 2, { width: IW });
        doc.y = y0 + H + 3;
      });
      doc.y += 6;
    }

    // Kaydi bulunamayanlar — kompakt iki sutun
    if (groups.none.length) {
      sectionHeader("Fireflies kaydı bulunamayan kartlar", groups.none.length, CONF.none.color);
      doc.font("body").fontSize(7.8).fillColor(MUTED).text(
        "Çoğu, Fireflies kullanımından önceki demolar ya da kaydedilmemiş toplantılar. Bu liste aynı zamanda 'kaydı olmayan demo' envanteridir.",
        M, doc.y, { width: CW },
      );
      doc.y += 4;
      const colW = (CW - 18) / 2;
      let col = 0;
      let colY = doc.y + 4;
      const colTop = colY;
      for (const r of groups.none) {
        doc.font("body").fontSize(8.6);
        const nameH = doc.heightOfString(r.cardName, { width: colW - 12 });
        const H = nameH + 11;
        if (colY + H > BOTTOM) {
          if (col === 0) {
            col = 1;
            colY = colTop;
          } else {
            doc.addPage();
            doc.y = M;
            col = 0;
            colY = M;
          }
        }
        const x = M + col * (colW + 18);
        doc.circle(x + 2.5, colY + 4.5, 1.6).fill("#8b949e");
        doc.fillColor(INK).font("body").fontSize(8.6)
          .text(r.cardName, x + 10, colY, { width: colW - 12 });
        doc.fillColor(MUTED).fontSize(7)
          .text(r.cardList, x + 10, colY + nameH + 0.5, { lineBreak: false });
        colY += H + 3;
      }
      doc.y = Math.max(colY, doc.y);
    }

    // ---------- Altbilgi (tum sayfalar) ----------
    // KRITIK: alt marjinin altina yazarken otomatik sayfa kirilimini kapat
    // (margins.bottom=0), yoksa pdfkit her altbilgi icin HAYALET SAYFA ekler.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const mb = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(M, FOOTER_Y).lineTo(M + CW, FOOTER_Y).lineWidth(0.6).stroke(FAINT);
      doc.font("body").fontSize(7.5).fillColor("#8b949e")
        .text("Validfor  ·  Trello ↔ Fireflies eşleştirme raporu", M, FOOTER_Y + 6, {
          lineBreak: false,
        });
      doc.text(`Sayfa ${i + 1} / ${range.count}`, M, FOOTER_Y + 6, {
        width: CW,
        align: "right",
        lineBreak: false,
      });
      doc.page.margins.bottom = mb;
    }
    doc.end();
  });
}

// ============================== ANA AKIS ==============================
async function main(): Promise<void> {
  const pdfOnly = process.argv.includes("--pdf-only");

  let report: Report;
  if (pdfOnly) {
    if (!fs.existsSync(JSON_PATH)) throw new Error(`${JSON_PATH} yok — once tam kosum yap`);
    report = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
    if (!Array.isArray(report.rows)) throw new Error("Eski format JSON — tam kosum gerekli");
    console.log(`JSON'dan ${report.rows.length} satir okundu (--pdf-only)`);
  } else {
    console.log("Trello kartlari cekiliyor...");
    const { boardName, cards } = await fetchBoardCards();
    console.log(`Board "${boardName}": ${cards.length} kart`);

    console.log("Fireflies transkript listesi cekiliyor...");
    const transcripts = await fetchTranscriptList({ max: 200 });
    console.log(`${transcripts.length} transkript`);

    const matches = matchCards(cards, transcripts);
    const ambiguousCount = matches.filter((m) => m.ambiguous).length;
    if (ambiguousCount) {
      console.log(`${ambiguousCount} belirsiz eslesme — Claude hakemligine gidiyor...`);
    }
    const verdicts = await adjudicate(matches);

    report = {
      boardName,
      generatedAt: new Date().toLocaleString("tr-TR", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "Europe/Istanbul",
      }),
      rows: matches.map((m) => {
        const v = verdicts.get(m.card.id);
        const rejected = Boolean(v && v.transcriptId === null && m.best);
        const use = m.best && !rejected ? m.best : null;
        return {
          cardId: m.card.id,
          cardName: m.card.name,
          cardList: m.card.listName,
          cardUrl: m.card.url,
          cardDue: m.card.due,
          transcriptId: use ? use.t.id : null,
          transcriptTitle: use ? use.t.title : null,
          transcriptDate: use && use.t.dateMs ? new Date(use.t.dateMs).toISOString() : null,
          score: m.best?.score ?? 0,
          confidence: rejected ? "none" : m.confidence,
          ambiguous: m.ambiguous,
          reasons: m.best?.reasons ?? [],
          claudeVerdict: v?.reason ?? null,
          rejected,
        };
      }),
    };
    // Konsol ozeti
    console.log("\n=== ESLESTIRME ===");
    for (const r of report.rows) {
      const tag = r.rejected
        ? "RED (Claude)"
        : r.transcriptId
          ? r.confidence.toUpperCase() + (r.ambiguous ? "?" : "")
          : "YOK";
      console.log(
        `[${tag.padEnd(12)}] ${r.cardName.slice(0, 40).padEnd(42)} -> ` +
          (r.transcriptId ? `${(r.transcriptTitle || "").slice(0, 45)} (skor ${r.score})` : "-"),
      );
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(JSON_PATH, JSON.stringify(report, null, 2));
    console.log(`\nJSON: ${JSON_PATH}`);
  }

  const pdf = await buildReportPDF(report);
  fs.writeFileSync(PDF_PATH, pdf);
  console.log(`PDF : ${PDF_PATH}`);
}

main().catch((e) => {
  console.error("HATA:", e?.message || e);
  process.exit(1);
});
