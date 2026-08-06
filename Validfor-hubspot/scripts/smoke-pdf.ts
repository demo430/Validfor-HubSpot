import { buildTranscriptPDF } from "../lib/pdf.js";
import type { Transcript } from "../lib/fireflies.js";

// Faz 3 duman testi: network'e cikmadan, Turkce karakterli sahte bir
// transkriptten gecerli bir PDF uretildigini dogrular (gomulu font crash
// etmemeli, cikti %PDF ile baslamali).
async function main(): Promise<void> {
  const fake: Transcript = {
    id: "TEST",
    title: "Şirket Toplantısı — Ğğ İı Öö Şş Üü Çç Testi",
    dateString: "2026-07-13T16:00:00.000Z",
    duration: 12,
    transcript_url: "https://app.fireflies.ai/view/TEST",
    meeting_attendees: [
      { displayName: "Ömer Çimen", email: "omer@validfor.com" },
      { displayName: "Nikhitha M", email: "nikhitha@example.com" },
    ],
    speakers: [{ name: "Ömer Çimen" }, { name: "Nikhitha M" }],
    sentences: [
      { speaker_name: "Ömer Çimen", text: "Merhaba, bu bir testtir. ışğüçöİĞŞ", start_time: 0 },
      { speaker_name: "Nikhitha M", text: "Hello, this is a test.", start_time: 7 },
    ],
    summary: {
      overview: "Kısa özet: Türkçe karakter ve font gömme testi.",
      action_items: "- Takip e-postası gönder\n- Dokümanı paylaş",
    },
  };

  const pdf = await buildTranscriptPDF(fake);
  const magic = pdf.subarray(0, 5).toString("latin1");
  console.log("PDF bytes :", pdf.length);
  console.log("magic     :", magic);
  const ok = magic === "%PDF-" && pdf.length > 2000;
  console.log(
    ok
      ? "\nOK: Faz 3 PDF duman testi gecti (gomulu font, gecerli PDF)"
      : "\nHATA: gecersiz PDF",
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
