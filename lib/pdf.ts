// Transkriptten PDF uretir. pdfkit + gomulu DejaVu Sans (Turkce karakter guvenli).
// Fontlar base64 Buffer olarak gomulu (lib/fonts.ts) -> serverless FS/__dirname
// bagimsiz calisir.
import PDFDocument from "pdfkit";
import { regular as FONT_REGULAR, bold as FONT_BOLD } from "./fonts.js";
import type { Transcript } from "./fireflies.js";

export interface PdfOptions {
  includeSummary?: boolean;
}

function formatDate(t: Transcript): string {
  const tryFmt = (d: Date): string | null => {
    if (isNaN(d.getTime())) return null;
    try {
      return d.toLocaleString("tr-TR", { dateStyle: "long", timeStyle: "short" });
    } catch {
      return d.toISOString().slice(0, 16).replace("T", " ");
    }
  };
  if (t.dateString) {
    const out = tryFmt(new Date(t.dateString));
    if (out) return out;
    return String(t.dateString);
  }
  if (t.date != null) {
    const ms = typeof t.date === "number" ? t.date : Number(t.date);
    const out = tryFmt(new Date(ms));
    if (out) return out;
  }
  return "";
}

function secondsToClock(s: number | null | undefined): string {
  if (s == null) return "";
  const total = Math.floor(Number(s));
  if (isNaN(total) || total < 0) return "";
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function asLines(val: string | string[] | null | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
  return String(val)
    .split("\n")
    .map((x) => x.replace(/^[-*•\s]+/, "").trim())
    .filter(Boolean);
}

// transcript -> Promise<Buffer>
export function buildTranscriptPDF(
  transcript: Transcript,
  options: PdfOptions = {},
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      // font: false -> constructor varsayilan Helvetica'yi YUKLEMEZ (serverless'ta
      // olmayan data/Helvetica.afm aranmaz). Asagida her zaman gomulu 'body'/'bold'
      // fontu set edilir.
      const doc = new PDFDocument({
        size: "A4",
        margin: 50,
        bufferPages: true,
        font: false,
        info: { Title: transcript.title || "Transcript" },
        // font:false pdfkit tipinde yok (font: string bekler) ama runtime'da
        // gecerli -> unknown uzerinden cast.
      } as unknown as PDFKit.PDFDocumentOptions);

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.registerFont("body", FONT_REGULAR);
      doc.registerFont("bold", FONT_BOLD);

      // --- Baslik ---
      doc
        .font("bold")
        .fontSize(18)
        .fillColor("#000")
        .text(transcript.title || "Toplanti Transkripti");
      doc.moveDown(0.3);

      // --- Meta ---
      doc.font("body").fontSize(10).fillColor("#555");
      const dateStr = formatDate(transcript);
      if (dateStr) doc.text(`Tarih: ${dateStr}`);

      const attendees = (transcript.meeting_attendees || [])
        .map((a) => a.displayName || a.name || a.email)
        .filter(Boolean) as string[];
      const speakers = (transcript.speakers || [])
        .map((s) => s.name)
        .filter(Boolean) as string[];
      const who = attendees.length ? attendees : speakers;
      if (who.length) doc.text(`Katilimcilar: ${who.join(", ")}`);

      if (transcript.duration != null && !isNaN(Number(transcript.duration))) {
        doc.text(`Sure: ${Math.round(Number(transcript.duration))} dk`);
      }

      const link = transcript.transcript_url || transcript.meeting_link;
      if (link) {
        doc.fillColor("#1155cc").text(`Fireflies: ${link}`, { link, underline: true });
      }
      doc.fillColor("#000").moveDown(0.8);

      // --- Ozet (varsa) ---
      const summary = transcript.summary || {};
      const overview = summary.overview || summary.short_summary;
      if (overview && options.includeSummary !== false) {
        doc.font("bold").fontSize(12).fillColor("#000").text("Ozet");
        doc.moveDown(0.2);
        doc
          .font("body")
          .fontSize(10)
          .fillColor("#222")
          .text(String(overview), { align: "justify" });
        doc.fillColor("#000").moveDown(0.5);

        const actions = asLines(summary.action_items);
        if (actions.length) {
          doc.font("bold").fontSize(12).text("Aksiyon Maddeleri");
          doc.moveDown(0.2).font("body").fontSize(10).fillColor("#222");
          for (const it of actions) doc.text(`•  ${it}`);
          doc.fillColor("#000").moveDown(0.5);
        }
      }

      // --- Tam transkript ---
      doc.font("bold").fontSize(12).fillColor("#000").text("Tam Transkript");
      doc.moveDown(0.3);

      const sentences = transcript.sentences || [];
      if (!sentences.length) {
        doc
          .font("body")
          .fontSize(10)
          .fillColor("#888")
          .text("(Transkript cumleleri bulunamadi.)");
      } else {
        let lastSpeaker: string | null = null;
        doc.fontSize(10);
        for (const s of sentences) {
          const sp = s.speaker_name || "Konusmaci";
          const clock = secondsToClock(s.start_time);
          if (sp !== lastSpeaker) {
            doc.moveDown(0.35);
            doc
              .font("bold")
              .fillColor("#111")
              .text(`${sp}${clock ? "  [" + clock + "]" : ""}`);
            lastSpeaker = sp;
          }
          doc.font("body").fillColor("#000").text(s.text || "");
        }
      }

      // --- Sayfa numaralari ---
      // Alt marjinin altina yazarken otomatik sayfa kirilimini kapat
      // (margins.bottom=0), yoksa pdfkit her numara icin HAYALET SAYFA ekler.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const mb = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const bottom = doc.page.height - 35;
        doc
          .font("body")
          .fontSize(8)
          .fillColor("#999")
          .text(`Sayfa ${i + 1} / ${range.count}`, 50, bottom, {
            align: "center",
            width: doc.page.width - 100,
            lineBreak: false,
          });
        doc.page.margins.bottom = mb;
      }

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

export { formatDate };
