// lib/replies.ts saf fonksiyon testleri. Ag yok, HubSpot yok.
// Kosum: npx tsx scripts/smoke-replies.ts
process.env.VALIDFOR_INTERNAL_DOMAINS ||= "validfor.com";

import {
  findContactReply,
  isCustomerReply,
  findReply,
  demoMs,
  parseMs,
  AUTO_SUBJECT_RE,
  REPLY_FROM_STAGES,
  REPLY_TO_STAGE,
} from "../lib/replies.js";
import { STAGE, computeDealStage } from "../lib/upsert.js";
import { plural } from "../lib/hubspot.js";

let pass = 0;
const fails: string[] = [];
function ok(cond: unknown, label: string): void {
  if (cond) pass++;
  else fails.push(label);
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(a === b, `${label} (beklenen ${JSON.stringify(b)}, gelen ${JSON.stringify(a)})`);
}

const DEMO = Date.parse("2026-09-10T12:00:00Z");
const after = (iso: string) => iso;

// --- 1) GERCEK musteri yanitlari ---
ok(
  isCustomerReply({ from: "a.efremov@itart.ch", subject: "Re: Validfor Digital Campaign" }),
  "dis domainden gelen yanit = cevap",
);
ok(
  isCustomerReply({ from: "ALI@ACME.COM", subject: "Fiyat hakkinda" }),
  "buyuk harfli adres = cevap (case-insensitive)",
);
ok(
  isCustomerReply({ from: "x@gmail.com", subject: "" }),
  "konu bos olsa da dis gonderen = cevap",
);
ok(
  isCustomerReply({ from: "no@acme.com", subject: "Re: teklif — ilgilenmiyoruz" }),
  "OLUMSUZ cevap da cevaptir (polarite ayirt edilmez)",
);

// --- 2) INCOMING_EMAIL tuzagi: BCC ile loglanan BIZIM giden mailimiz ---
// Portalda dogrulanan gercek kayit: direction=INCOMING_EMAIL ama from bizim.
ok(
  !isCustomerReply({
    from: "elif.yesil@validfor.com",
    subject: "Following up on our last conversation – Validfor",
  }),
  "ic domainden gelen (BCC log artefakti) cevap DEGIL",
);
ok(
  !isCustomerReply({ from: "bharani.rajendran@validfor.com", subject: "Re: [EXTERNAL] Re: ..." }),
  "bizim Re: yanitimiz cevap DEGIL",
);
ok(
  !isCustomerReply({
    from: "founders@validfor.com",
    subject: "Automatic reply: Validfor | 10+ investors",
  }),
  "kendi aliasimizdan otomatik yanit cevap DEGIL",
);

// --- 3) Otomatik yanit / takvim bildirimi kaliplari (DIS gonderenden) ---
const autoSubjects = [
  "Automatic reply: Validfor demo",
  "Auto: I am away",
  "Out of Office: back Monday",
  "Out of the office",
  "Otomatik yanıt: izinliyim",
  "Otomatik yanit: izinliyim",
  "Abwesenheit: Urlaub",
  "Réponse automatique : absent",
  "Respuesta automática: fuera",
  "Invitation: Al Sudair- Validation Software @ Tue 29 Sept",
  "Updated invitation: Demo @ Wed",
  "Canceled event: Validfor Demo",
  "Accepted: Validfor Demo",
  "Declined: Validfor Demo",
  "Tentative: Validfor Demo",
  "Re: Automatic reply: still away",
  // Tireli/alt cizgili varyantlar — Outlook/Exchange boyle yaziyor.
  // "Out-Of-Office Re: ..." portalda gorulen GERCEK bir konu.
  "Out-Of-Office Re: Validfor - Next Steps discussion",
  "Out-of-Office",
  "Automatic-Reply: away",
  "Updated-invitation: Demo",
  "Otomatik-yanıt: izinliyim",
  "delivery-status-notification",
  "Undeliverable: Validfor",
  "Mail Delivery Subsystem",
  "Delivery Status Notification (Failure)",
];
for (const s of autoSubjects) {
  ok(!isCustomerReply({ from: "someone@acme.com", subject: s }), `otomatik/takvim atilir: "${s}"`);
  ok(AUTO_SUBJECT_RE.test(s), `AUTO_SUBJECT_RE yakalar: "${s}"`);
}

// Yanlis pozitif olmamali: icinde "accepted" gecen normal konu.
ok(
  isCustomerReply({ from: "ali@acme.com", subject: "We have accepted your proposal" }),
  "konu ORTASINDA 'accepted' gecen gercek cevap atilmaz",
);
ok(
  isCustomerReply({ from: "ali@acme.com", subject: "Invitations are open for our event" }),
  "'Invitations' ile baslayan ama davet olmayan konu atilmaz (kelime siniri)",
);

// --- 4) Gonderen bilinmiyor ---
ok(!isCustomerReply({ from: "", subject: "Re: demo" }), "bos gonderen cevap DEGIL");
ok(!isCustomerReply({ from: null, subject: "Re: demo" }), "null gonderen cevap DEGIL");
ok(!isCustomerReply({ from: "gecersiz", subject: "Re: demo" }), "@ yok -> cevap DEGIL");

// --- 5) findReply: demo tarihinden SONRA olmali ---
eq(
  findReply(
    [{ from: "ali@acme.com", subject: "Re: demo", timestamp: after("2026-09-09T10:00:00Z") }],
    DEMO,
  ),
  null,
  "demodan ONCEKI yanit sayilmaz",
);
eq(
  findReply(
    [{ from: "ali@acme.com", subject: "Re: demo", timestamp: "2026-09-10T12:00:00Z" }],
    DEMO,
  ),
  null,
  "demo ANINDAKI mail sayilmaz (strict >)",
);
{
  const hit = findReply(
    [
      { from: "elif.yesil@validfor.com", subject: "Following up", timestamp: "2026-09-12T08:00:00Z" },
      { from: "ali@acme.com", subject: "Re: demo", timestamp: "2026-09-11T09:00:00Z" },
      { from: "veli@acme.com", subject: "Re: demo", timestamp: "2026-09-14T09:00:00Z" },
      { from: "x@acme.com", subject: "Accepted: Demo", timestamp: "2026-09-15T09:00:00Z" },
    ],
    DEMO,
  );
  ok(hit != null, "karisik listede gercek yanit bulunur");
  eq(hit?.from, "veli@acme.com", "EN YENI gercek yanit secilir (auto/ic olanlar atlanir)");
}
eq(findReply([], DEMO), null, "bos liste -> null");
eq(
  findReply([{ from: "ali@acme.com", subject: "Re: demo", timestamp: "gecersiz-tarih" }], DEMO),
  null,
  "parse edilemeyen tarih sayilmaz",
);

// --- 6) demoMs / parseMs ---
eq(
  demoMs({ ff_last_meeting_date: "2026-09-10T12:00:00Z", createdate: "2026-01-01T00:00:00Z" }),
  DEMO,
  "ff_last_meeting_date createdate'e gore oncelikli",
);
eq(
  demoMs({ createdate: "2026-01-01T00:00:00Z" }),
  Date.parse("2026-01-01T00:00:00Z"),
  "ff yoksa createdate",
);
eq(demoMs({}), null, "tarih yok -> null (kart atlanir)");
eq(parseMs(""), null, "bos string -> null");
eq(parseMs(null), null, "null -> null");

// --- 7) Stage sabitleri ve yon ---
eq(REPLY_TO_STAGE, "6147225815", "In Progress stage id'si");
eq(REPLY_TO_STAGE, STAGE.inProgress, "REPLY_TO_STAGE = STAGE.inProgress");
ok(REPLY_FROM_STAGES.includes(STAGE.meeting), "Meeting'den tasinir");
ok(REPLY_FROM_STAGES.includes(STAGE.followUp), "Follow-Up'tan tasinir");
eq(REPLY_FROM_STAGES.length, 2, "yalniz bu iki stage kaynak");
for (const manual of [
  STAGE.unassigned,
  STAGE.scheduled,
  "decisionmakerboughtin", // Contract
  "contractsent", //         PoC
  "5737116873", //           No show
  "5823539423", //           Partnership
  "5706717430", //           Lost/Not Now
]) {
  ok(!REPLY_FROM_STAGES.includes(manual), `manuel/giris stage'i kaynak DEGIL: ${manual}`);
}

// --- 8) computeDealStage: In Progress GERI goturulmez ---
eq(
  computeDealStage(STAGE.inProgress),
  null,
  "In Progress'te yeni toplanti stage'i degistirmez (geri goturmez)",
);
eq(computeDealStage(STAGE.meeting), STAGE.followUp, "Meeting + yeni toplanti -> Follow-Up (degismedi)");
eq(computeDealStage(STAGE.followUp), null, "Follow-Up + yeni toplanti -> dokunma (degismedi)");
eq(computeDealStage(""), STAGE.meeting, "yeni deal -> Meeting (degismedi)");
eq(computeDealStage(STAGE.scheduled), STAGE.meeting, "Scheduled -> Meeting (degismedi)");
eq(computeDealStage("contractsent"), null, "PoC manuel bolge -> dokunma (degismedi)");

// --- 9) plural() haritasi: "email" eksikse URL sessizce 404 olur ve
// reply-sweep her karti "cevap yok" sayar (2026-09'da yasanan hata).
eq(plural("email"), "emails", "plural('email') = 'emails' (404 regresyonu)");
eq(plural("emails"), "emails", "plural('emails') = 'emails'");
eq(plural("deal"), "deals", "plural('deal') = 'deals'");
eq(plural("note"), "notes", "plural('note') = 'notes'");
eq(plural("meeting"), "meetings", "plural('meeting') = 'meetings'");
eq(plural("company"), "companies", "plural('company') = 'companies'");
eq(plural("contact"), "contacts", "plural('contact') = 'contacts'");

// --- 10) YEDEK yol: kisi uzerindeki hs_sales_email_last_replied ---
eq(findContactReply([], DEMO), null, "yedek: bos liste -> null");
eq(
  findContactReply([{ email: "ali@acme.com", replied: "2026-09-09T10:00:00Z" }], DEMO),
  null,
  "yedek: demodan ONCEKI yanit sayilmaz",
);
eq(
  findContactReply([{ email: "ali@acme.com", replied: "2026-09-10T12:00:00Z" }], DEMO),
  null,
  "yedek: demo ANINDAKI damga sayilmaz (strict >)",
);
{
  const hit = findContactReply(
    [{ email: "ali@acme.com", replied: "2026-09-14T09:00:00Z" }],
    DEMO,
  );
  ok(hit != null, "yedek: demodan SONRAKI yanit bulunur");
  eq(hit?.email, "ali@acme.com", "yedek: dogru kisi");
}
// Ic kisiler de bu damgayi tasiyor (portalda: ugur.metinol@validfor.com) —
// elenmeleri sart, yoksa her kart "cevap geldi" olur.
eq(
  findContactReply([{ email: "ugur.metinol@validfor.com", replied: "2026-09-14T09:00:00Z" }], DEMO),
  null,
  "yedek: IC kisinin damgasi sayilmaz",
);
{
  const hit = findContactReply(
    [
      { email: "ugur.metinol@validfor.com", replied: "2026-09-20T09:00:00Z" },
      { email: "ali@acme.com", replied: "2026-09-12T09:00:00Z" },
      { email: "veli@acme.com", replied: "2026-09-15T09:00:00Z" },
    ],
    DEMO,
  );
  eq(hit?.email, "veli@acme.com", "yedek: ic kisi atlanir, EN YENI dis kisi secilir");
}
eq(
  findContactReply([{ email: "", replied: "2026-09-14T09:00:00Z" }], DEMO),
  null,
  "yedek: bos e-posta sayilmaz",
);
eq(
  findContactReply([{ email: "ali@acme.com", replied: null }], DEMO),
  null,
  "yedek: damga yoksa sayilmaz",
);
eq(
  findContactReply([{ email: "ali@acme.com", replied: "gecersiz" }], DEMO),
  null,
  "yedek: parse edilemeyen damga sayilmaz",
);

console.log(`${pass} kontrol gecti, ${fails.length} basarisiz`);
for (const f of fails) console.error("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
