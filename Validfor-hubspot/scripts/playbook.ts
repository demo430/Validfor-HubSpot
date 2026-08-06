// Validfor GTM Otomasyon Oyun Kitabi (playbook) PDF ureticisi.
// Marka: validfor logosu (turkuaz swoosh-check + kucuk harf wordmark) vektor
// olarak yeniden cizilir; renkler logo turkuazindan turetilir.
//
// Calistir:  npx tsx scripts/playbook.ts   ->  out/validfor-playbook.pdf
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { regular as FONT_REGULAR, bold as FONT_BOLD } from "../lib/fonts.js";

const OUT_DIR = path.join(process.cwd(), "out");
const PDF_PATH = path.join(OUT_DIR, "validfor-playbook.pdf");

// ============================== MARKA PALETI ==============================
const BRAND = "#2ed9b4"; //     logo turkuazi
const BRAND_DK = "#0f9d80"; //  beyaz zeminde okunur koyu turkuaz
const BRAND_BG = "#e4faf4"; //  acik turkuaz dolgu (chip/panel)
const BAND = "#0b2f2a"; //      koyu petrol yesili (kapak/baslik/tablo bandi)
const INK = "#1d2b28"; //       ana metin
const MUTED = "#5f7370"; //     ikincil metin
const FAINT = "#d7e3df"; //     cizgiler
const ZEBRA = "#f3faf7"; //     satir arkaplani
const AMBER = "#b3820a"; //     ELLE (insan) vurgusu
const AMBER_BG = "#fdf3dc";
const RED = "#c94f42"; //       uyari

const A4W = 595.28;
const A4H = 841.89;
const M = 46;
const CW = A4W - 2 * M;
const FOOTER_Y = A4H - 34;
const BOTTOM = FOOTER_Y - 14;

// ============================== YARDIMCILAR ==============================
type Doc = PDFKit.PDFDocument;

function buildPlaybook(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: M,
      bufferPages: true,
      font: false,
      info: { Title: "Validfor · GTM Otomasyon Oyun Kitabı" },
    } as unknown as PDFKit.PDFDocumentOptions) as Doc;
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont("body", FONT_REGULAR);
    doc.registerFont("bold", FONT_BOLD);

    let pageNo = 1;
    const toc: Array<{ n: number; title: string; page: number }> = [];
    const addPage = (): void => {
      doc.addPage();
      pageNo += 1;
      doc.y = M;
    };
    const ensure = (h: number): void => {
      if (doc.y + h > BOTTOM) addPage();
    };

    // --- logo: turkuaz swoosh-check "v" + kucuk harf wordmark ---
    // h = wordmark punto yuksekligi; check, v harfinin yerine gecer.
    const drawLogo = (x: number, y: number, h: number, textColor: string): number => {
      const cw = h * 1.02; // check genisligi
      const top = y + h * 0.30; // x-yuksekligi hizasi
      const bot = y + h * 0.78;
      doc.save();
      doc.lineWidth(h * 0.17).lineCap("round").lineJoin("round");
      doc
        .moveTo(x + cw * 0.02, y + h * 0.38)
        .lineTo(x + cw * 0.38, bot)
        .lineTo(x + cw * 1.06, y + h * 0.12)
        .stroke(BRAND);
      void top;
      doc.restore();
      doc.font("bold").fontSize(h).fillColor(textColor);
      const tx = x + cw * 1.18;
      doc.text("alidfor", tx, y, { lineBreak: false });
      return tx + doc.widthOfString("alidfor"); // sag kenar
    };

    // --- bolum baslangici: her bolum yeni sayfada ---
    const section = (n: number, title: string, subtitle: string): void => {
      addPage();
      toc.push({ n, title, page: pageNo });
      const y = M;
      doc.roundedRect(M, y, 26, 26, 6).fill(BRAND_DK);
      doc.font("bold").fontSize(14).fillColor("#ffffff").text(String(n), M, y + 5.5, {
        width: 26,
        align: "center",
        lineBreak: false,
      });
      doc.font("bold").fontSize(16).fillColor(INK).text(title, M + 36, y + 1, {
        width: CW - 36,
        lineBreak: false,
      });
      doc.font("body").fontSize(9).fillColor(MUTED).text(subtitle, M + 36, y + 21, {
        width: CW - 36,
        lineBreak: false,
      });
      doc.moveTo(M, y + 40).lineTo(M + CW, y + 40).lineWidth(0.8).stroke(FAINT);
      doc.y = y + 52;
    };

    const sub = (title: string): void => {
      ensure(30);
      const y = doc.y + 4;
      doc.rect(M, y + 1, 3.5, 12).fill(BRAND);
      doc.font("bold").fontSize(11.5).fillColor(INK).text(title, M + 11, y, { lineBreak: false });
      doc.y = y + 22;
    };

    const para = (text: string, opts: { size?: number; color?: string } = {}): void => {
      doc.font("body").fontSize(opts.size ?? 9.2).fillColor(opts.color ?? INK);
      const h = doc.heightOfString(text, { width: CW, lineGap: 2 });
      ensure(h + 6);
      doc.text(text, M, doc.y, { width: CW, lineGap: 2 });
      doc.y += 6;
    };

    // basligi koyu, aciklamasi gri madde isareti
    const bullets = (items: Array<[string, string] | string>, indent = 0): void => {
      for (const it of items) {
        const [head, rest] = typeof it === "string" ? ["", it] : it;
        const x = M + 12 + indent;
        const w = CW - 12 - indent;
        doc.fontSize(9.2);
        doc.font(head ? "bold" : "body");
        const joined = head ? `${head} — ${rest}` : rest;
        // yukseklik olcumu: tek akista bold+body karisimi yerine tam metinle olc
        doc.font("body");
        const h = doc.heightOfString(joined, { width: w, lineGap: 1.5 });
        ensure(h + 5);
        const y = doc.y;
        doc.circle(x - 8, y + 4.6, 1.7).fill(BRAND_DK);
        if (head) {
          doc.font("bold").fillColor(INK).text(`${head} — `, x, y, {
            width: w,
            continued: true,
            lineGap: 1.5,
          });
          doc.font("body").fillColor(INK).text(rest, { width: w, lineGap: 1.5 });
        } else {
          doc.font("body").fillColor(INK).text(rest, x, y, { width: w, lineGap: 1.5 });
        }
        doc.y += 4;
      }
      doc.y += 2;
    };

    // numarali adim listesi
    const steps = (items: Array<[string, string]>): void => {
      items.forEach(([title, desc], i) => {
        doc.font("bold").fontSize(9.6);
        const tH = doc.heightOfString(title, { width: CW - 30 });
        doc.font("body").fontSize(8.8);
        const dH = doc.heightOfString(desc, { width: CW - 30, lineGap: 1.5 });
        const H = tH + 2 + dH + 10;
        ensure(H);
        const y = doc.y;
        doc.circle(M + 9, y + 7, 9).fill(BRAND_DK);
        doc.font("bold").fontSize(9).fillColor("#ffffff").text(String(i + 1), M, y + 2.6, {
          width: 18,
          align: "center",
          lineBreak: false,
        });
        doc.font("bold").fontSize(9.6).fillColor(INK).text(title, M + 30, y, { width: CW - 30 });
        doc.font("body").fontSize(8.8).fillColor(MUTED).text(desc, M + 30, y + tH + 2, {
          width: CW - 30,
          lineGap: 1.5,
        });
        // dikey baglanti cizgisi
        if (i < items.length - 1) {
          doc.moveTo(M + 9, y + 17).lineTo(M + 9, y + H - 2).lineWidth(1).stroke(FAINT);
        }
        doc.y = y + H;
      });
      doc.y += 4;
    };

    // genel tablo: koyu baslik bandi + zebra + hucre kaydirma
    const table = (
      headers: string[],
      widths: number[],
      rows: string[][],
      opts: { size?: number; boldCol?: number } = {},
    ): void => {
      const size = opts.size ?? 8.4;
      const PADX = 7;
      const PADY = 5.5;
      const xs: number[] = [];
      let acc = M;
      for (const w of widths) {
        xs.push(acc);
        acc += w;
      }
      const headerH = 20;
      const drawHeader = (): void => {
        const y = doc.y;
        doc.rect(M, y, CW, headerH).fill(BAND);
        doc.font("bold").fontSize(size - 0.4).fillColor("#ffffff");
        headers.forEach((h, i) =>
          doc.text(h, xs[i] + PADX, y + 6, { width: widths[i] - 2 * PADX, lineBreak: false }),
        );
        doc.y = y + headerH;
      };
      ensure(headerH + 30);
      drawHeader();
      rows.forEach((row, ri) => {
        doc.fontSize(size);
        const hs = row.map((cell, i) => {
          doc.font(i === (opts.boldCol ?? -1) ? "bold" : "body");
          return doc.heightOfString(cell, { width: widths[i] - 2 * PADX, lineGap: 1.2 });
        });
        const H = Math.max(...hs) + 2 * PADY;
        if (doc.y + H > BOTTOM) {
          addPage();
          drawHeader();
        }
        const y = doc.y;
        if (ri % 2 === 0) doc.rect(M, y, CW, H).fill(ZEBRA);
        row.forEach((cell, i) => {
          doc
            .font(i === (opts.boldCol ?? -1) ? "bold" : "body")
            .fontSize(size)
            .fillColor(i === (opts.boldCol ?? -1) ? INK : "#39494f");
          doc.text(cell, xs[i] + PADX, y + PADY, { width: widths[i] - 2 * PADX, lineGap: 1.2 });
        });
        doc.moveTo(M, y + H).lineTo(M + CW, y + H).lineWidth(0.4).stroke(FAINT);
        doc.y = y + H;
      });
      doc.y += 10;
    };

    // pipeline chip akisi: chip + ok + chip; chip altinda OTO/ELLE rozeti
    type Chip = { label: string; mode: "OTO" | "ELLE" | "GİRİŞ" };
    const chipFlow = (chips: Chip[]): void => {
      const chipH = 24;
      const arrowW = 16;
      doc.font("bold").fontSize(8.6);
      const ws = chips.map((c) => doc.widthOfString(c.label) + 18);
      const totalW = ws.reduce((a, b) => a + b, 0) + arrowW * (chips.length - 1);
      const scale = totalW > CW ? CW / totalW : 1;
      ensure(chipH + 26);
      let x = M + (CW - totalW * scale) / 2;
      const y = doc.y + 2;
      chips.forEach((c, i) => {
        const w = ws[i] * scale;
        const isAuto = c.mode === "OTO";
        const isEntry = c.mode === "GİRİŞ";
        const border = isAuto ? BRAND_DK : isEntry ? BRAND_DK : AMBER;
        const fill = isAuto ? BRAND_BG : "#ffffff";
        doc.roundedRect(x, y, w, chipH, 7).lineWidth(1.1).fillAndStroke(fill, border);
        doc.font("bold").fontSize(8.6 * scale > 7 ? 8.6 : 8.6).fillColor(INK);
        doc.text(c.label, x, y + 7.4, { width: w, align: "center", lineBreak: false });
        // rozet
        doc.font("bold").fontSize(6.8).fillColor(isAuto || isEntry ? BRAND_DK : AMBER);
        doc.text(c.mode, x, y + chipH + 4, { width: w, align: "center", lineBreak: false });
        x += w;
        if (i < chips.length - 1) {
          const ay = y + chipH / 2;
          doc.moveTo(x + 3, ay).lineTo(x + arrowW - 5, ay).lineWidth(1.2).stroke(MUTED);
          doc
            .moveTo(x + arrowW - 5, ay - 3)
            .lineTo(x + arrowW - 1, ay)
            .lineTo(x + arrowW - 5, ay + 3)
            .fill(MUTED);
          x += arrowW;
        }
      });
      doc.y = y + chipH + 18;
    };

    // vurgulu bilgi paneli
    const panel = (
      title: string,
      lines: string[],
      color: string = BRAND_DK,
      bg: string = BRAND_BG,
    ): void => {
      doc.fontSize(8.6);
      doc.font("body");
      const innerW = CW - 24;
      const hs = lines.map((l) => doc.heightOfString(l, { width: innerW - 12, lineGap: 1.5 }));
      const H = 12 + 13 + hs.reduce((a, b) => a + b + 4, 0) + 6;
      ensure(H + 4);
      const y = doc.y;
      doc.roundedRect(M, y, CW, H, 8).fill(bg);
      doc.rect(M, y, 3.5, H).fill(color);
      doc.font("bold").fontSize(9).fillColor(color).text(title, M + 14, y + 10, {
        lineBreak: false,
      });
      let yy = y + 10 + 15;
      lines.forEach((l, i) => {
        doc.circle(M + 18, yy + 4.4, 1.6).fill(color);
        doc.font("body").fontSize(8.6).fillColor(INK).text(l, M + 26, yy, {
          width: innerW - 12,
          lineGap: 1.5,
        });
        yy += hs[i] + 4;
      });
      doc.y = y + H + 10;
    };

    // diyagram kutusu
    const dbox = (
      x: number,
      y: number,
      w: number,
      h: number,
      title: string,
      sub1: string,
      opts: { fill?: string; border?: string; titleColor?: string } = {},
    ): void => {
      doc.roundedRect(x, y, w, h, 7).lineWidth(1.1).fillAndStroke(opts.fill ?? "#ffffff", opts.border ?? FAINT);
      doc.font("bold").fontSize(8.8).fillColor(opts.titleColor ?? INK);
      doc.text(title, x + 8, y + 8, { width: w - 16, lineBreak: false });
      if (sub1) {
        doc.font("body").fontSize(7.2).fillColor(MUTED);
        doc.text(sub1, x + 8, y + 21, { width: w - 16, lineGap: 1 });
      }
    };
    const harrow = (x1: number, x2: number, y: number, label = ""): void => {
      doc.moveTo(x1, y).lineTo(x2 - 5, y).lineWidth(1.2).stroke(BRAND_DK);
      doc.moveTo(x2 - 5, y - 3.2).lineTo(x2, y).lineTo(x2 - 5, y + 3.2).fill(BRAND_DK);
      if (label) {
        doc.font("body").fontSize(6.6).fillColor(MUTED);
        doc.text(label, x1 - 14, y - 11, { width: x2 - x1 + 28, align: "center", lineBreak: false });
      }
    };

    // ============================== KAPAK ==============================
    const bandH = 296;
    doc.rect(0, 0, A4W, bandH).fill(BAND);
    // filigran check (sag ust)
    doc.save();
    doc.opacity(0.1);
    doc.lineWidth(34).lineCap("round").lineJoin("round");
    doc.moveTo(A4W - 210, 120).lineTo(A4W - 130, 214).lineTo(A4W + 40, -6).stroke(BRAND);
    doc.opacity(1);
    doc.restore();
    drawLogo(M, 44, 30, "#ffffff");
    doc.font("bold").fontSize(27).fillColor("#ffffff");
    doc.text("GTM Otomasyon Oyun Kitabı", M, 138, { width: CW });
    doc.font("body").fontSize(11.5).fillColor(BRAND);
    doc.text("Fireflies → Claude → HubSpot · toplantıdan CRM'e uçtan uca akış", M, 176, {
      width: CW,
    });
    doc.font("body").fontSize(9).fillColor("#9db8b1");
    doc.text(
      "Bu doküman; satış ve yatırımcı görüşmelerinin nasıl otomatik işlendiğini, pipeline kurallarını, " +
        "zenginleştirme katmanını ve operasyon el kitabını tek yerde anlatır.",
      M,
      206,
      { width: CW - 60, lineGap: 2.5 },
    );
    doc.font("bold").fontSize(8.5).fillColor("#ffffff");
    doc.text("validfor.vercel.app", M, 258, { lineBreak: false });
    const metaX = M + doc.widthOfString("validfor.vercel.app");
    doc.font("body").fontSize(8.5).fillColor("#9db8b1");
    doc.text("  ·  Sürüm: Temmuz 2026", metaX, 258, { lineBreak: false });

    // ozet kutulari
    const tiles: Array<[string, string, string]> = [
      ["4", "giriş kaynağı", "Fireflies · Calendly · Takvim · Trello"],
      ["2", "pipeline", "Sales + VC, ayrı aşama makineleri"],
      ["7", "API ucu", "webhook · sweep · sync · backfill"],
      ["3", "zamanlanmış görev", "15 dk Apollo + günlük süpürücüler"],
    ];
    const gap = 10;
    const tw = (CW - 3 * gap) / 4;
    const th = 60;
    const ty = bandH + 20;
    tiles.forEach((t, i) => {
      const x = M + i * (tw + gap);
      doc.roundedRect(x, ty, tw, th, 8).fillAndStroke(ZEBRA, FAINT);
      doc.font("bold").fontSize(20).fillColor(BRAND_DK).text(t[0], x + 10, ty + 8, {
        lineBreak: false,
      });
      doc.font("bold").fontSize(8).fillColor(INK).text(t[1], x + 10, ty + 31, {
        width: tw - 20,
        lineBreak: false,
      });
      doc.font("body").fontSize(6.6).fillColor(MUTED).text(t[2], x + 10, ty + 43, {
        width: tw - 18,
        lineGap: 1,
      });
    });

    // icindekiler (girisler bolumler cizildikten sonra doldurulur)
    const tocHeadY = ty + th + 24;
    doc.font("bold").fontSize(12.5).fillColor(INK).text("İçindekiler", M, tocHeadY, {
      lineBreak: false,
    });
    doc.moveTo(M, tocHeadY + 18).lineTo(M + CW, tocHeadY + 18).lineWidth(0.7).stroke(FAINT);
    const tocListY = tocHeadY + 26;
    const TOC_LINE = 19.5;

    // 5 altin kural paneli (kapak alti)
    const rulesY = tocListY + 8 * TOC_LINE + 16;
    const rules = [
      "Otomasyon yalnız BOŞ alanları doldurur — insanın yazdığı hiçbir değer ezilmez.",
      "Deal'lar yalnız İLERİ taşınır; hiçbir kapanış otomatik değildir, kapanış her zaman insandadır.",
      "Her Fireflies transkripti tam olarak BİR kez işlenir (ff_processed_transcripts işareti).",
      "Apollo'ya kişi başına ömür boyu TEK sorgu gider (apollo_enriched_at damgası, kredi koruması).",
      "Sırlar yalnız Vercel env + .env.local'de yaşar; koda ve repoya asla yazılmaz.",
    ];
    doc.fontSize(8.6).font("body");
    const rH = 12 + 13 + rules.reduce((a, l) => a + doc.heightOfString(l, { width: CW - 38, lineGap: 1.5 }) + 4, 0) + 6;
    doc.roundedRect(M, rulesY, CW, rH, 8).fill(BRAND_BG);
    doc.rect(M, rulesY, 3.5, rH).fill(BRAND_DK);
    doc.font("bold").fontSize(9).fillColor(BRAND_DK).text("Beş altın kural", M + 14, rulesY + 10, { lineBreak: false });
    let ry = rulesY + 25;
    for (const l of rules) {
      doc.circle(M + 18, ry + 4.4, 1.6).fill(BRAND_DK);
      doc.font("body").fontSize(8.6).fillColor(INK).text(l, M + 26, ry, { width: CW - 38, lineGap: 1.5 });
      ry += doc.heightOfString(l, { width: CW - 38, lineGap: 1.5 }) + 4;
    }

    // ============================== BOLUM 1 ==============================
    section(1, "Sistem Haritası", "Kim kiminle konuşuyor: kaynaklar, işleme, hedefler");
    para(
      "Sistem, Validfor'un müşteri ve yatırımcı görüşmelerini insan müdahalesi olmadan CRM'e işler. " +
        "Dört giriş kaynağı tek bir Vercel uygulamasında birleşir; Claude toplantıyı anlar ve yapılandırılmış " +
        "veri üretir; sonuç HubSpot'a yazılır; Apollo eksik kişi ve şirket bilgilerini tamamlar.",
    );
    doc.y += 4;
    // --- diyagram ---
    {
      const dy = doc.y;
      const srcW = 132;
      const srcH = 34;
      const srcGap = 10;
      const sources: Array<[string, string]> = [
        ["Fireflies", "toplantı transkripti (webhook)"],
        ["Calendly", "book edilen demolar"],
        ["Google Takvim", "planlı VC toplantıları"],
        ["cron-job.org + Vercel", "zamanlanmış tetikler"],
      ];
      const colH = sources.length * srcH + (sources.length - 1) * srcGap;
      sources.forEach((s, i) => {
        dbox(M, dy + i * (srcH + srcGap), srcW, srcH, s[0], s[1]);
      });
      // orta: vercel
      const vx = M + srcW + 46;
      const vw = 138;
      const vy = dy + 8;
      const vh = 72;
      dbox(vx, vy, vw, vh, "validfor.vercel.app", "Hono uygulaması\nwebhook doğrulama · idempotency · aşama makinesi", {
        fill: BRAND_BG,
        border: BRAND_DK,
        titleColor: BRAND_DK,
      });
      // orta-alt: claude (dar — sagindaki serit Apollo baglantisina kalir) + apollo
      const cy = vy + vh + 34;
      const cwClaude = 112;
      dbox(vx, cy, cwClaude, 48, "Claude", "claude-sonnet-5 · şemaya zorlanmış tek JSON üretir");
      const ay2 = cy + 48 + 18;
      dbox(vx, ay2, vw, 44, "Apollo", "kişi + şirket zenginleştirme (people/match)");
      // sag: hubspot
      const hx = vx + vw + 46;
      const hw = A4W - M - hx;
      dbox(hx, vy, hw, vh + 44, "HubSpot CRM", "Deals (Sales + VC pipeline)\nContacts · Companies\nNotlar · Meeting kayıtları\nözel ff_* alanları", {
        fill: "#ffffff",
        border: BRAND_DK,
      });
      // oklar
      sources.forEach((_, i) => {
        const sy = dy + i * (srcH + srcGap) + srcH / 2;
        doc.moveTo(M + srcW, sy).lineTo(M + srcW + 18, sy).lineWidth(1).stroke(MUTED);
        doc.moveTo(M + srcW + 18, sy).lineTo(M + srcW + 18, vy + vh / 2).lineWidth(1).stroke(MUTED);
      });
      harrow(M + srcW + 18, vx, vy + vh / 2);
      harrow(vx + vw, hx, vy + (vh + 44) / 2 - 18);
      // vercel <-> claude cift yonlu dikey
      const midX = vx + cwClaude / 2;
      doc.moveTo(midX - 5, vy + vh).lineTo(midX - 5, cy).lineWidth(1).stroke(MUTED);
      doc.moveTo(midX - 5, cy - 5).lineTo(midX - 8, cy - 9).moveTo(midX - 5, cy - 5).lineTo(midX - 2, cy - 9).stroke(MUTED);
      doc.moveTo(midX + 5, cy).lineTo(midX + 5, vy + vh).lineWidth(1).stroke(MUTED);
      doc.moveTo(midX + 5, vy + vh + 5).lineTo(midX + 2, vy + vh + 9).moveTo(midX + 5, vy + vh + 5).lineTo(midX + 8, vy + vh + 9).stroke(MUTED);
      // vercel <-> apollo: Claude'un sagindaki bos seritten inen cift yonlu hat
      const apX = vx + cwClaude + (vw - cwClaude) / 2;
      doc.moveTo(apX, vy + vh).lineTo(apX, ay2).lineWidth(1).stroke(MUTED);
      doc.moveTo(apX, vy + vh + 5).lineTo(apX - 3, vy + vh + 9).moveTo(apX, vy + vh + 5).lineTo(apX + 3, vy + vh + 9).stroke(MUTED);
      doc.moveTo(apX, ay2 - 5).lineTo(apX - 3, ay2 - 9).moveTo(apX, ay2 - 5).lineTo(apX + 3, ay2 - 9).stroke(MUTED);
      doc.y = Math.max(dy + colH, ay2 + 44) + 16;
    }
    sub("Veri yolculuğu (özet)");
    bullets([
      ["Gerçek zaman", "Fireflies bir toplantıyı transkript eder etmez webhook'u çağırır; toplantı dakikalar içinde HubSpot'tadır."],
      ["Günlük ağ", "stage-sweep cron'u süpürücüleri, Calendly ve Google Takvim senkronlarını çalıştırır — webhook kaçsa bile sistem kendini onarır."],
      ["15 dakikalık döngü", "cron-job.org, /api/apollo-sync'i çağırır; HubSpot'a yeni düşen contact'lar Apollo ile zenginleşir."],
      ["Tek yönlü yazım", "otomasyon HubSpot'a yazar ama insanların girdiği veriyi asla ezmez (boş-alan ilkesi)."],
    ]);

    // ============================== BOLUM 2 ==============================
    section(2, "Toplantı Akışı", "Fireflies → Claude → HubSpot: bir toplantının yolculuğu");
    steps([
      ["Tetik ve doğrulama", "Fireflies transkripsiyonu bitirince POST /api/fireflies'ı çağırır. İstek x-webhook-secret başlığıyla doğrulanır; imzasız/yanlış imzalı istek reddedilir."],
      ["Transkript çekilir", "Başlık, tarih, katılımcılar, konuşmacı bazlı metin ve özet Fireflies API'sinden alınır."],
      ["Yinelenme kontrolü (idempotency)", "Transkript kimliği deal'daki ff_processed_transcripts alanında ve eski not kayıtlarında aranır. İşlenmişse akış durur — aynı toplantı iki kez yazılmaz; webhook güvenle tekrar oynatılabilir."],
      ["Claude sınıflandırır", "Şirket adı, toplantı tipi (demo / yatırımcı / diğer), özet, sonraki adımlar, sektör, ICP, rakip çözüm, deal tutarı, toplantı sahibi, 'karşı taraf katıldı mı' ve yatırımcıysa fon profili — hepsi şemaya zorlanmış tek JSON çıktıda döner. Şemada olmayan hiçbir şey uydurulamaz."],
      ["Yönlendirme", "meetingType=investor ise VC Pipeline'a, diğer her şey Sales Pipeline'a gider. Boş transkriptli ama alan adı fon kokan (capital/ventures/vc) davetler de yatırımcı sayılır."],
      ["Şirket + kişi + deal upsert", "Alan adı (domain) üzerinden şirket ve kişiler bulunur ya da oluşturulur. Deal önce işlenmiş transkript işaretiyle, sonra domain'le aranır; ada göre açılmış eski bir deal bulunursa benimsenip yeniden adlandırılır — duplike deal oluşmaz."],
      ["Kayıtlar yazılır", "Toplantı özeti not olarak şirket + kişi + deal'a bağlanır; toplantı kaydı (meeting engagement) COMPLETED ya da NO_SHOW sonucuyla oluşturulur — böylece HubSpot'un Last Contacted alanları kendiliğinden güncellenir. Transkript PDF'i dosya olarak eklenir."],
      ["Aşama makinesi + kart alanları", "Deal, pipeline kurallarına göre yalnız ileri taşınır (Bölüm 3–4); ff_last_meeting_* alanları ve kart alanları boş-alan ilkesiyle doldurulur."],
      ["Sahip ataması", "Toplantı sahibi önce transkriptteki bilgiden, yoksa dahili katılımcıdan bulunur. demo@, connect@ gibi ortak hesaplar hiçbir zaman sahip yazılmaz; güvenilir aday yoksa alan bilinçli boş kalır."],
    ]);

    // ============================== BOLUM 3 ==============================
    section(3, "Sales Pipeline", "Unassigned → Scheduled → Meeting → Follow-Up · gerisi insanda");
    chipFlow([
      { label: "Unassigned", mode: "GİRİŞ" },
      { label: "Scheduled", mode: "ELLE" },
      { label: "Meeting", mode: "OTO" },
      { label: "Follow-Up", mode: "OTO" },
      { label: "Contract · PoC · Won/Lost", mode: "ELLE" },
    ]);
    table(
      ["Aşama", "Nasıl girilir / ilerler", "Kim taşır"],
      [88, 330, 85],
      [
        ["Unassigned", "Calendly'den demo book edilince deal otomatik burada açılır; yeni görüşmeler de buraya düşer.", "Otomasyon (giriş)"],
        ["Scheduled", "Ekip toplantıyı değerlendirip elle taşır.", "İnsan"],
        ["Meeting", "Fireflies toplantısı gerçekleşince otomatik.", "Otomasyon"],
        ["Follow-Up", "Aynı deal'a İKİNCİ toplantı gelince otomatik.", "Otomasyon"],
        ["Contract / PoC / Won / Lost", "Tamamen manuel bölge — otomasyon bu aşamalara asla dokunmaz, geri de çekmez.", "İnsan"],
        ["No show", "Toplantıya karşı taraftan kimse katılmadıysa ve deal giriş bölgesindeyse (Unassigned/Scheduled) otomatik taşınır.", "Otomasyon"],
      ],
      { boldCol: 0 },
    );
    sub("Kurallar ve güvenlik ağları");
    bullets([
      ["Yalnız ileri", "otomasyon deal'ı hiçbir zaman geri çekmez; kapanış (Won/Lost) her zaman insandadır."],
      ["Hayata dönüş", "No show'daki bir deal'a gerçek bir toplantı gelirse deal Meeting'e döner."],
      ["Günlük süpürücü 1", "Scheduled/Unassigned'da bekleyen deal'ın işlenmiş transkripti varsa Meeting'e taşınır (kaçan webhook telafisi)."],
      ["Günlük süpürücü 2", "Meeting'de 7 gün hareketsiz kalan deal Follow-Up'a taşınır."],
      ["Kart zenginleştirme", "deal type, sektör, ICP, çalışan sayısı, rakip çözüm alanları yalnız boşsa transkriptten dolar."],
      ["Bilinçli manuel alanlar", "Validfor Priority, Likelihood ve Demo Status otomatik DOLMAZ — bu üç alan ekibin yargısına ayrılmıştır."],
    ]);

    // ============================== BOLUM 4 ==============================
    section(4, "VC Pipeline", "Yatırımcı görüşmeleri: yönlendirme, fon profili, bilet kuralları");
    chipFlow([
      { label: "Contacted", mode: "ELLE" },
      { label: "Meeting", mode: "OTO" },
      { label: "Follow-up", mode: "OTO" },
      { label: "Due Diligence → Term Sheet → Closed", mode: "ELLE" },
    ]);
    bullets([
      ["Yönlendirme", "Claude'un yatırımcı görüşmesi (meetingType=investor) olarak işaretlediği her toplantı VC Pipeline'a gider; Sales'e karışmaz."],
      ["İlk toplantı", "deal'ı doğrudan Meeting'de açar. Aynı toplantının bir de 'ikinci toplantı' sayılıp deal'ı Follow-up'a sıçratması ayrıca engellenir."],
      ["İkinci toplantı", "aynı fonla yeni bir görüşme gerçekleşince deal otomatik Follow-up'a ilerler; Due Diligence ve sonrası tamamen insandadır."],
      ["Katılmadıysa", "karşı taraf toplantıya gelmediyse VC deal'ı yerinde kalır (VC Pipeline'da No show aşaması yoktur) ve ilerleme sayılmaz."],
    ]);
    sub("Fon profili (About VC kartı)");
    para(
      "Investment Vertical(s), Investment Stage, Investment Region, Minimum/Maximum Ticket Size ve " +
        "Investment Type alanları transkriptte söylenenden dolar. Alanlar HubSpot'ta ETİKETE göre bulunur; " +
        "portal yeniden yapılandırılsa bile kod kırılmaz. Kartın son alanı Likelihood bilinçli olarak hiçbir zaman otomatik dolmaz.",
    );
    bullets([
      ["Bilet kuralı", "fonun 'ortalama çek/bilet' rakamı Maximum Ticket Size'a yazılır; bir ortalama asla minimum sayılmaz."],
      ["İkinci geçiş (gap-catcher)", "ana sınıflandırma fon profilini boş bırakırsa, yalnız fon profiline odaklı ikinci bir Claude sorgusu aynı transkripti tekrar tarar. Transkriptte söylenmemiş bilgi yine de üretilmez."],
      ["Duplike önleme", "deal önce işlenmiş transkript işaretiyle, sonra domain'le aranır; ada göre açılmış eski deal benimsenir ve yeniden adlandırılır; gerekirse HubSpot merge ile birleştirilir."],
      ["Boş transkript istisnası", "hiç konuşma yakalanamamış ama davetli alan adı fon kokan (capital / ventures / vc) toplantılar yatırımcı sayılır ve VC Pipeline'da açılır."],
    ]);

    // ============================== BOLUM 5 ==============================
    section(5, "Zenginleştirme Katmanı (Apollo)", "HubSpot'a düşen kişi ve şirketler otomatik tamamlanır");
    para(
      "HubSpot'a düşen her yeni contact, Apollo'ya EN FAZLA BİR KEZ sorulur. cron-job.org her 15 dakikada " +
        "/api/apollo-sync'i çağırır; uç, damgasız contact'ları en yeniden eskiye tarar ve işler.",
    );
    sub("Kişi katmanı");
    bullets([
      ["Seçim", "apollo_enriched_at damgası olmayan contact'lar, en yeni oluşturulandan başlanarak alınır (tur başına en çok 50)."],
      ["Dahili filtre", "Validfor adresleri Apollo'ya hiç sorulmaz → damga: skipped."],
      ["Kredi koruması", "ad, soyad, unvan ve LinkedIn zaten doluysa Apollo'ya sorulmaz → damga: complete. Kredi yalnız gerçekten eksik kayda harcanır."],
      ["Zenginleştirme", "Apollo people/match ile ad, soyad, unvan, telefon, şehir, ülke, LinkedIn ve şirket YALNIZ boşsa doldurulur → damga: işlem tarihi."],
      ["Bulunamadı / hata", "Apollo kişiyi bulamazsa damga 'notfound + tarih' olur; hata olursa damga atılmaz ve kayıt sonraki turda kendiliğinden yeniden denenir."],
    ]);
    sub("Şirket katmanı");
    bullets([
      ["Aynı sorgudan", "kişi eşleşmesinin organizasyon verisiyle şirket domain üzerinden bulunur ya da oluşturulur ve contact'a bağlanır."],
      ["Alanlar", "website, LinkedIn sayfası, endüstri (HubSpot enum'una eşlenir), çalışan sayısı, telefon, şehir, ülke — yalnız boşsa dolar."],
      ["Toplu telafi", "/api/backfill-companies var olan tüm şirketleri aynı kuralla topluca tamamlar (tek seferlik koşuldu: 125 şirket, 0 hata)."],
    ]);
    sub("apollo_enriched_at damga sözlüğü");
    table(
      ["Değer", "Anlamı"],
      [150, 353],
      [
        ["2026-07-22T09:15:00Z (ISO tarih)", "Contact bu tarihte Apollo'dan zenginleştirildi."],
        ["complete", "Çekirdek alanlar zaten doluydu; Apollo'ya hiç sorulmadı (kredi harcanmadı)."],
        ["notfound 2026-07-22", "Apollo bu e-postayı tanımadı; tekrar sorulmayacak."],
        ["skipped", "Dahili (Validfor) adres; zenginleştirme kapsamı dışında."],
        ["(boş)", "Henüz işlenmedi; en geç 15 dakika içinde cron alacak."],
      ],
      { boldCol: 0, size: 8.6 },
    );

    // ============================== BOLUM 6 ==============================
    section(6, "Giriş Kaynakları", "Sisteme veri hangi kapılardan giriyor");
    table(
      ["Kaynak", "Ne yapar", "Sıklık"],
      [105, 293, 105],
      [
        ["Fireflies webhook", "Biten her toplantıyı gerçek zamanlı işler — sistemin ana kapısı. Birden çok Fireflies hesabı aynı webhook adresine bağlanabilir.", "Gerçek zamanlı"],
        ["Calendly", "Book edilen demo, Sales Pipeline'da Unassigned aşamasında deal olarak açılır.", "Günlük (sweep içinde) + elle"],
        ["Google Takvim", "Planlanmış yatırımcı toplantıları VC Pipeline'da deal açar.", "Günlük (sweep içinde) + elle"],
        ["Trello backfill", "Eski demo board'u tek seferlik içe aktarıldı: 53 yüksek güvenli eşleşme, 31 yeni deal. Orta güvenli 8 kart backlog'da bekliyor.", "Tek seferlik (tamam)"],
        ["VC backfill", "Geçmiş yatırımcı toplantıları tek seferlik işlendi (~24 fon; profiller elle doğrulandı).", "Tek seferlik (tamam)"],
        ["Elle tetik", "Her uç ?dry=1 ile önizlemeli olarak elle de çağrılabilir (Bölüm 7).", "İhtiyaç halinde"],
      ],
      { boldCol: 0 },
    );
    panel("İlk temas kuralı", [
      "Outreach başlar başlamaz contact HubSpot'a düşer (Apollo listesi ya da ilk e-posta).",
      "Contact düştüğü anda 15 dakikalık Apollo döngüsü onu yakalar ve profili tamamlar.",
      "Toplantı gerçekleştiğinde Fireflies akışı aynı kişiyi ve şirketi bulur — mükerrer kayıt oluşmaz.",
    ]);

    // ============================== BOLUM 7 ==============================
    section(7, "Operasyon El Kitabı", "Uçlar, zamanlanmış görevler, ortam değişkenleri, komutlar");
    sub("API uçları (validfor.vercel.app)");
    table(
      ["Uç", "Ne yapar", "Tetik"],
      [150, 253, 100],
      [
        ["GET /", "Sağlık: sürüm + yayında olan commit'i gösterir.", "Herkese açık"],
        ["POST /api/fireflies", "Toplantı işleme webhook'u (ana akış).", "Fireflies"],
        ["POST /api/apollo-sync", "Damgasız contact'ları zenginleştirir. ?max=N, ?dry=1.", "15 dk + günlük 07:00"],
        ["POST /api/stage-sweep", "Süpürücüler + Calendly ve Takvim senkronları. ?dry=1.", "Günlük 07:30"],
        ["POST /api/calendly-sync", "Calendly senkronunu tek başına koşar. ?dry=1, ?days=N.", "Elle / önizleme"],
        ["POST /api/calendar-sync", "VC takvim senkronunu tek başına koşar. ?dry=1, ?past=N.", "Elle / önizleme"],
        ["POST /api/backfill-companies", "Tüm şirket kartlarını Apollo verisiyle topluca tamamlar.", "Elle (tek seferlik)"],
      ],
      { boldCol: 0, size: 8.2 },
    );
    para(
      "Kimlik doğrulama: korumalı uçlar x-webhook-secret başlığı ya da Authorization: Bearer (CRON_SECRET) ister. " +
        "GET çağrıları yalnız ?dry=1 ile ÖNİZLER; veri yazan koşum POST ister (tek istisna: Vercel Cron'un " +
        "Bearer'lı GET'i). Anahtarı URL'ye (?key=) koymaktan kaçının — erişim loglarında kalır.",
      { size: 8.6, color: MUTED },
    );
    sub("Zamanlanmış görevler");
    table(
      ["Zamanlayıcı", "Uç", "Sıklık", "Not"],
      [110, 145, 95, 153],
      [
        ["cron-job.org", "/api/apollo-sync", "15 dakikada bir", "x-webhook-secret başlığıyla; 30 sn zaman aşımı"],
        ["Vercel Cron", "/api/apollo-sync", "Günlük 07:00 UTC", "Yedek tur"],
        ["Vercel Cron", "/api/stage-sweep", "Günlük 07:30 UTC", "Süpürücüler + takvim/Calendly senkronu"],
      ],
      { boldCol: 0, size: 8.2 },
    );
    sub("Ortam değişkenleri (yalnız adlar — değerler asla repoya girmez)");
    table(
      ["Servis", "Değişkenler"],
      [110, 393],
      [
        ["Fireflies", "FIREFLIES_API_KEY · FIREFLIES_WEBHOOK_SECRET"],
        ["HubSpot", "HUBSPOT_TOKEN · HUBSPOT_API_BASE (ops., EU varsayılan)"],
        ["Claude", "ANTHROPIC_API_KEY"],
        ["Apollo", "APOLLO_API_KEY (master key: people/match yetkisi şart)"],
        ["Calendly", "CALENDLY_TOKEN"],
        ["Google Takvim", "GOOGLE_CALENDAR_ID · GOOGLE_SA_EMAIL · GOOGLE_SA_PRIVATE_KEY (ya da GOOGLE_CALENDAR_API_KEY)"],
        ["Trello (backfill)", "TRELLO_KEY · TRELLO_TOKEN · TRELLO_BOARD"],
        ["Genel", "CRON_SECRET · VALIDFOR_INTERNAL_DOMAINS · VC_EXCLUDE_DOMAINS"],
      ],
      { boldCol: 0, size: 8.2 },
    );
    ensure(150); // baslik + tablo basi ayni sayfada kalsin (yetim baslik olmasin)
    sub("Bakım komutları (repo içinden)");
    table(
      ["Komut", "Ne yapar"],
      [180, 323],
      [
        ["npm run setup-properties", "HubSpot'taki özel alan grubunu ve ff_* / apollo_* alanlarını kurar, tazeler (idempotent)."],
        ["npm run match-trello", "Trello ↔ Fireflies eşleştirme raporu üretir (PDF + JSON); HubSpot'a dokunmaz."],
        ["npm run backfill-trello", "Eşleştirme raporundan HubSpot'a tek seferlik geri doldurma koşar."],
        ["npm run smoke-*", "Ağa çıkmadan tüm akışları test eder (upsert, webhook, sweep, apollo, calendly, vcfields...)."],
      ],
      { boldCol: 0, size: 8.2 },
    );

    // ============================== BOLUM 8 ==============================
    section(8, "Sorun Giderme", "Belirti → önce nereye bak → çözüm");
    table(
      ["Belirti", "Önce buraya bak", "Çözüm"],
      [130, 175, 198],
      [
        [
          "Toplantı HubSpot'a düşmedi",
          "GET / sağlık ucu (sürüm + commit) ve Fireflies webhook ayarı",
          "Webhook adresini ve FIREFLIES_WEBHOOK_SECRET eşleşmesini doğrula; gerekirse transkript kimliğiyle /api/fireflies'a elle POST at — idempotency sayesinde tekrar oynatmak güvenlidir.",
        ],
        [
          "Deal Meeting'e geçmedi",
          "Deal'ın aşaması + ff_processed_transcripts alanı",
          "Günlük süpürücü kendiliğinden onarır; bekleyemiyorsan /api/stage-sweep'i elle çağır.",
        ],
        [
          "VC kart alanları boş",
          "Transkriptte bilgi gerçekten söylenmiş mi",
          "Gap-catcher ikinci geçiş fon profilini tekrar dener; söylenmemiş bilgi üretilmez — bu durumda alanı elle doldur.",
        ],
        [
          "Deal owner boş ya da yanlış",
          "Toplantıyı açan hesap ortak hesap mı (demo@, connect@)",
          "Ortak hesaplar bilinçli olarak sahip yazılmaz; güvenilir aday yoksa alan boş bırakılır — gerçek sahibi elle ata.",
        ],
        [
          "Aynı şirkete iki deal",
          "İki deal'ın domain'i ve pipeline'ı aynı mı",
          "Sistem domain + ad benimseme ve merge uygular; eski istisnaları HubSpot'ta elle merge et.",
        ],
        [
          "Apollo 403 hatası",
          "API anahtarının people/match yetkisi",
          "Master API key kullan. Hatalı denemeler damgalanmaz; anahtar düzelince kayıtlar sonraki cron turunda kendiliğinden işlenir.",
        ],
        [
          "Contact zenginleşmedi",
          "apollo_enriched_at değeri (Bölüm 5 sözlüğü)",
          "complete = çekirdek zaten doluydu, sorulmadı; boş = 15 dk içinde cron alacak; notfound = Apollo tanımıyor, elle doldur.",
        ],
        [
          "Webhook 401 dönüyor",
          "Gönderilen x-webhook-secret başlığı",
          "Başlık değeri Vercel'deki FIREFLIES_WEBHOOK_SECRET ile birebir aynı olmalı (cron-job.org'da başlık adında iki nokta olmadan).",
        ],
        [
          "Fireflies auth_failed",
          "FIREFLIES_API_KEY güncel mi",
          "Yeni anahtarı Vercel env'e koy, redeploy et; arada kaçan toplantıları webhook'u elle oynatarak işle.",
        ],
      ],
      { boldCol: 0, size: 7.9 },
    );

    // ============================== ICINDEKILER (geri doldur) =============
    const range = doc.bufferedPageRange();
    doc.switchToPage(0);
    {
      const mb = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      toc.forEach((e, i) => {
        const y = tocListY + i * TOC_LINE;
        doc.font("bold").fontSize(9.5).fillColor(BRAND_DK).text(String(e.n), M + 2, y, {
          width: 14,
          lineBreak: false,
        });
        doc.font("body").fontSize(9.5).fillColor(INK).text(e.title, M + 22, y, { lineBreak: false });
        const tW = doc.widthOfString(e.title);
        const pStr = String(e.page);
        const pW = doc.widthOfString(pStr);
        // noktali kilavuz
        const dotsX1 = M + 22 + tW + 8;
        const dotsX2 = M + CW - pW - 10;
        doc.save();
        doc.moveTo(dotsX1, y + 7).lineTo(dotsX2, y + 7).lineWidth(0.8).dash(1, { space: 3 }).stroke(FAINT);
        doc.undash();
        doc.restore();
        doc.font("body").fontSize(9.5).fillColor(MUTED).text(pStr, M + CW - pW, y, { lineBreak: false });
      });
      doc.page.margins.bottom = mb;
    }

    // ============================== ALTBILGI ==============================
    // KRITIK: alt marj 0'lanmazsa pdfkit her altbilgi icin hayalet sayfa acar.
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const mb = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(M, FOOTER_Y).lineTo(M + CW, FOOTER_Y).lineWidth(0.6).stroke(FAINT);
      // mini logo: check + validfor
      doc.save();
      doc.lineWidth(1.6).lineCap("round").lineJoin("round");
      doc.moveTo(M, FOOTER_Y + 12).lineTo(M + 3.4, FOOTER_Y + 15.4).lineTo(M + 10.4, FOOTER_Y + 6.6).stroke(BRAND);
      doc.restore();
      doc.font("bold").fontSize(7.5).fillColor(MUTED).text("validfor", M + 14, FOOTER_Y + 7.5, {
        lineBreak: false,
      });
      doc.font("body").fontSize(7.5).fillColor("#8ba39c").text("  ·  GTM Otomasyon Oyun Kitabı", M + 14 + doc.widthOfString("validfor"), FOOTER_Y + 7.5, {
        lineBreak: false,
      });
      doc.font("body").fontSize(7.5).fillColor("#8ba39c").text(`Sayfa ${i + 1} / ${range.count}`, M, FOOTER_Y + 7.5, {
        width: CW,
        align: "right",
        lineBreak: false,
      });
      doc.page.margins.bottom = mb;
    }
    doc.end();
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pdf = await buildPlaybook();
  fs.writeFileSync(PDF_PATH, pdf);
  console.log(`Yazildi: ${PDF_PATH} (${(pdf.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
