import {
  emailDomain,
  isInternalEmail,
  splitName,
  nameFromEmail,
  ownerNameFromEmail,
  internalOwnerFromAttendees,
  isSharedAccountEmail,
  buildNoteBody,
  midnightUtcMs,
  computeDealStage,
  computeVcDealStage,
  STAGE,
  VC_STAGE,
  parseProcessedList,
  appendProcessed,
  normCompanyName,
  sameCompanyName,
} from "../lib/upsert.js";

// Faz 5 duman testi: upsert'in saf yardimcilarini network'e cikmadan dogrular.
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

// emailDomain
check("emailDomain", emailDomain("Rahul.S@AmpleLogic.com") === "amplelogic.com");
check("emailDomain bos", emailDomain("") === "");

// isInternalEmail (varsayilan validfor.com)
check("internal validfor", isInternalEmail("demo@validfor.com") === true);
check("external amplelogic", isInternalEmail("rahul.s@amplelogic.com") === false);

// splitName
check("splitName iki parca", JSON.stringify(splitName("Saikiran Kothapally")) === JSON.stringify({ firstName: "Saikiran", lastName: "Kothapally" }));
check("splitName tek parca", JSON.stringify(splitName("Omer")) === JSON.stringify({ firstName: "Omer", lastName: "" }));
check("splitName bos", JSON.stringify(splitName("")) === JSON.stringify({ firstName: "", lastName: "" }));

// nameFromEmail / ownerNameFromEmail
check("nameFromEmail nokta", JSON.stringify(nameFromEmail("saikiran.k@amplelogic.com")) === JSON.stringify({ firstName: "Saikiran", lastName: "K" }));
check("nameFromEmail tek parca", JSON.stringify(nameFromEmail("manne@amplelogic.com")) === JSON.stringify({ firstName: "Manne", lastName: "" }));
check("nameFromEmail rakam atar", JSON.stringify(nameFromEmail("jane.doe.1985@x.com")) === JSON.stringify({ firstName: "Jane", lastName: "Doe" }));
check("nameFromEmail bos", JSON.stringify(nameFromEmail("")) === JSON.stringify({ firstName: "", lastName: "" }));
check("ownerNameFromEmail", ownerNameFromEmail("omer.cimen@validfor.com") === "Omer Cimen");

// internalOwnerFromAttendees / isSharedAccountEmail — ortak hesaplar owner olamaz
check("shared: demo@", isSharedAccountEmail("demo@validfor.com") === true);
check("shared: gercek kisi degil", isSharedAccountEmail("bharani.rajendran@validfor.com") === false);
const tOwner: any = {
  id: "T",
  organizer_email: "demo@validfor.com", // ortak hesap organize etmis
  meeting_attendees: [
    { email: "demo@validfor.com" },
    { email: "demo-requests@validfor.com", displayName: "Demo Requests" },
    { email: "bharani.rajendran@validfor.com" },
    { email: "jane@acme.com", displayName: "Jane Doe" },
  ],
};
check("owner: ortak hesabi atlar, gercek kisiyi bulur", internalOwnerFromAttendees(tOwner) === "Bharani Rajendran");
const tNoOwner: any = {
  id: "T2",
  organizer_email: "demo@validfor.com",
  meeting_attendees: [{ email: "demo@validfor.com" }, { email: "jane@acme.com" }],
};
check("owner: gercek kisi yoksa bos (Demo yazilmaz)", internalOwnerFromAttendees(tNoOwner) === "");
const tDisplay: any = {
  id: "T3",
  meeting_attendees: [{ email: "omer.cimen@validfor.com", displayName: "Ömer Çimen" }],
};
check("owner: displayName oncelikli", internalOwnerFromAttendees(tDisplay) === "Ömer Çimen");

// buildNoteBody — link + ozet + adimlar, HTML-escape, FF-ID tokeni
const body = buildNoteBody(
  {
    companyName: "X", meetingType: "demo", summary: "A <b>test</b> & summary.",
    nextSteps: ["Do X", "Do Y"],
    dealType: "", dealAmount: null, country: "", meetingOwner: "",
    sector: "", icp: "", headcount: null, competitorSolution: "", externalAttended: true,
    investmentVerticals: [], investmentStages: [], investmentRegions: [],
    minTicketSize: null, maxTicketSize: null, investmentType: "",
    attendeeProfiles: [],
  },
  "https://app.fireflies.ai/view/01KX354T93DF90PKFXQ33XV0C6",
  "01KX354T93DF90PKFXQ33XV0C6",
);
check("note ozet iceriyor", body.includes("test") && body.includes("summary"));
check("note HTML-escape ediyor", body.includes("&lt;b&gt;") && body.includes("&amp;"));
check("note nextSteps iceriyor", body.includes("<li>Do X</li>") && body.includes("<li>Do Y</li>"));
check("note fireflies link (ULID) iceriyor", body.includes("01KX354T93DF90PKFXQ33XV0C6"));
check("note FF-ID tokeni iceriyor", body.includes("<p>FF-ID: 01KX354T93DF90PKFXQ33XV0C6</p>"));

// parseProcessedList / appendProcessed — idempotency isaret listesi
check("processed: bos parse", JSON.stringify(parseProcessedList("")) === "[]");
check("processed: null parse", JSON.stringify(parseProcessedList(null)) === "[]");
check("processed: parse", JSON.stringify(parseProcessedList("A;B ; C")) === JSON.stringify(["A", "B", "C"]));
check("processed: append yeni", appendProcessed("A;B", "C") === "A;B;C");
check("processed: append mukerrer eklemez", appendProcessed("A;B", "B") === "A;B");
check("processed: bosa append", appendProcessed("", "X") === "X");
const many = Array.from({ length: 70 }, (_, i) => `ID${i}`).join(";");
const appended = parseProcessedList(appendProcessed(many, "NEW"));
check("processed: 60 ile sinirli", appended.length === 60 && appended[appended.length - 1] === "NEW");

// midnightUtcMs — gece yarisi UTC'ye indirir
const noon = Date.UTC(2026, 6, 13, 12, 30, 0); // 2026-07-13 12:30 UTC
check("midnightUtcMs gece yarisi", midnightUtcMs(noon) === Date.UTC(2026, 6, 13));

// --- computeDealStage: YENI Sales Pipeline otomasyonu (2026-07 yapisi) ---
// Unassigned/Scheduled elle -> toplanti gerceklesince Meeting -> ikinci
// toplanti Follow-Up -> Contract/PoC/Won/Lost manuel.
const MANUAL = {
  contract: "decisionmakerboughtin", // "Contract" (eski 3rd Meeting id'si)
  poc: "contractsent", //               "PoC" (eski Demo Delivered id'si)
  won: "5706717429",
  lost: "5706717430",
};

check("stage: yeni deal -> Meeting", computeDealStage("") === STAGE.meeting);
check("stage: Unassigned -> Meeting", computeDealStage(STAGE.unassigned) === STAGE.meeting);
check("stage: Scheduled -> Meeting", computeDealStage(STAGE.scheduled) === STAGE.meeting);
check("stage: Meeting -> Follow-Up (ikinci toplanti)", computeDealStage(STAGE.meeting) === STAGE.followUp);
check("stage: Follow-Up -> dokunma (gerisi manuel)", computeDealStage(STAGE.followUp) === null);
check("stage: Contract -> dokunma", computeDealStage(MANUAL.contract) === null);
check("stage: PoC -> dokunma", computeDealStage(MANUAL.poc) === null);
check("stage: Won -> dokunma", computeDealStage(MANUAL.won) === null);
check("stage: Lost -> dokunma", computeDealStage(MANUAL.lost) === null);
check("stage: bilinmeyen -> dokunma", computeDealStage("some_custom_stage_xyz") === null);

// --- computeVcDealStage: VC Pipeline otomasyonu (2026-07 VC yapisi) ---
// Contacted elle -> toplanti gerceklesince Meeting -> ikinci toplanti
// Follow-up -> Due Diligence/Term Sheet/Won/Lost/Not Priority manuel.
const VC_MANUAL = {
  dueDiligence: "5733954776",
  termSheet: "5732106487",
  won: "5732106489",
  lost: "5732107450",
  notPriority: "5732559078",
};

check("vc stage: yeni deal -> Meeting", computeVcDealStage("") === VC_STAGE.meeting);
check("vc stage: Contacted -> Meeting", computeVcDealStage(VC_STAGE.contacted) === VC_STAGE.meeting);
check("vc stage: Meeting -> Follow-up (ikinci toplanti)", computeVcDealStage(VC_STAGE.meeting) === VC_STAGE.followUp);
check("vc stage: Follow-up -> dokunma (gerisi manuel)", computeVcDealStage(VC_STAGE.followUp) === null);
check("vc stage: Due Diligence -> dokunma", computeVcDealStage(VC_MANUAL.dueDiligence) === null);
check("vc stage: Term Sheet -> dokunma", computeVcDealStage(VC_MANUAL.termSheet) === null);
check("vc stage: Won -> dokunma", computeVcDealStage(VC_MANUAL.won) === null);
check("vc stage: Lost -> dokunma", computeVcDealStage(VC_MANUAL.lost) === null);
check("vc stage: Not Priority -> dokunma", computeVcDealStage(VC_MANUAL.notPriority) === null);
check("vc stage: bilinmeyen -> dokunma", computeVcDealStage("some_custom_stage_xyz") === null);

// --- sameCompanyName: mukerrer kart ureten ad farkliliklari ---
// Ayni firmadan iki kisi Calendly formuna farkli ad yazinca iki kart aciliyordu.
check("ad: birebir ayni", sameCompanyName("Julphar", "Julphar") === true);
check("ad: buyuk/kucuk harf + bosluk", sameCompanyName("  julphar ", "Julphar") === true);
check("ad: noktalama farki", sameCompanyName("Julphar, Inc.", "Julphar Inc") === true);
check("ad: kelime sinirinda onek -> AYNI",
  sameCompanyName("Julphar", "Julphar Pharmaceutical") === true);
check("ad: onek degil -> FARKLI",
  sameCompanyName("AZ Pharmaceutical", "Alembic Pharmaceuticals") === false);
check("ad: ortak son kelime yetmez -> FARKLI",
  sameCompanyName("Global", "Terra Link Global") === false);
check("ad: kelime ortasinda kesisme -> FARKLI",
  sameCompanyName("Julp", "Julphar") === false);
check("ad: cok kisa ad -> FARKLI", sameCompanyName("IT", "ITART Consulting") === false);
check("ad: bos -> FARKLI", sameCompanyName("", "Julphar") === false);
check("normCompanyName", normCompanyName("  Julphar,  Inc. ") === "julphar inc");

console.log(
  fail === 0
    ? "\nOK: Faz 5 upsert duman testi gecti"
    : `\nHATA: ${fail} kontrol basarisiz`,
);
process.exit(fail === 0 ? 0 : 1);
