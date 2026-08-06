import {
  normKey,
  resolveVcProps,
  coerceVcValue,
  buildVcPatch,
} from "../lib/vcfields.js";
import type { MeetingExtract } from "../lib/classify.js";

// VC kart duman testi: etiket->ic ad cozumleme + tip bazli deger indirgeme +
// bos-alan kuralli patch, network'e cikmadan dogrulanir.
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

// normKey — etiket/secenek/ic ad ayni anahtara insin
check("normKey parantez", normKey("Investment Vertical(s)") === "investmentverticals");
check("normKey ic ad", normKey("investment_vertical_s_") === "investmentverticals");
check("normKey tire-bosluk", normKey("Co - Lead") === "colead");
check("normKey bos", normKey("") === "");

// Sahte HubSpot property listesi (UI'nin uretebilecegi ic adlarla)
const PROPS = [
  {
    name: "investment_vertical_s_", label: "Investment Vertical(s)",
    type: "enumeration", fieldType: "checkbox",
    options: [
      { label: "SaaS", value: "SaaS" },
      { label: "Life Sciences", value: "Life Sciences" },
      { label: "Deep Tech", value: "Deep Tech" },
    ],
  },
  {
    name: "investment_stage", label: "Investment Stage",
    type: "enumeration", fieldType: "checkbox",
    options: [
      { label: "Pre-Seed", value: "Pre - Seed" },
      { label: "Seed", value: "Seed" },
      { label: "Series A", value: "Series A" },
    ],
  },
  { name: "investment_region", label: "Investment Region", type: "string", fieldType: "text", options: [] },
  { name: "minimum_ticket_size", label: "Minimum Ticket Size", type: "number", fieldType: "number", options: [] },
  { name: "maximum_ticket_size", label: "Maximum Ticket Size", type: "number", fieldType: "number", options: [] },
  {
    name: "investment_type", label: "Investment Type",
    type: "enumeration", fieldType: "select",
    options: [
      { label: "Lead", value: "Lead" },
      { label: "Co - Lead", value: "Co - Lead" },
      { label: "Follow - On", value: "Follow - On" },
    ],
  },
  // Kart disi / manuel alanlar — cozumlemeye ASLA girmemeli
  { name: "likelihood", label: "Likelihood", type: "enumeration", fieldType: "select", options: [] },
  { name: "deal_owner_validfor", label: "Deal Owner Validfor", type: "string", fieldType: "text", options: [] },
];

const resolved = resolveVcProps(PROPS);
check("resolve: 6 kart alani cozuldu", Object.keys(resolved).length === 6);
check("resolve: etiketten ic ada", resolved.verticals?.name === "investment_vertical_s_");
check("resolve: likelihood kartta YOK (manuel)",
  !Object.values(resolved).some((d) => d!.name === "likelihood"));

// Ic ad uzerinden cozumleme (etiket farkliysa yedek yol)
const byName = resolveVcProps([
  { name: "minimum_ticket_size", label: "Min. Ticket", type: "number", fieldType: "number" },
]);
check("resolve: ic addan yedek eslesme", byName.minTicket?.name === "minimum_ticket_size");
check("resolve: eksik alan haritada yok", byName.verticals === undefined);

// coerceVcValue — enum coklu (checkbox): eslesenler ";" ile, eslesmeyen atilir
check("coerce: checkbox coklu + eslesmeyen atilir",
  coerceVcValue(resolved.verticals!, ["SaaS", "Deep Tech", "Fintech"]) === "SaaS;Deep Tech");
check("coerce: hicbiri eslesmezse null",
  coerceVcValue(resolved.verticals!, ["Fintech"]) === null);
// enum secenek DEGERI etiketten farkliysa deger yazilir ("Pre-Seed" -> "Pre - Seed")
check("coerce: secenek degeri normalize eslesir",
  coerceVcValue(resolved.stages!, ["Pre-Seed"]) === "Pre - Seed");
// enum tekli (select): ilk eslesme
check("coerce: select tekli", coerceVcValue(resolved.type!, ["co-lead"]) === "Co - Lead");
// number / text
check("coerce: number", coerceVcValue(resolved.minTicket!, [500000]) === 500000);
check("coerce: text coklu ', ' ile",
  coerceVcValue(resolved.regions!, ["Europe", "MENA"]) === "Europe, MENA");
check("coerce: bos girdi null", coerceVcValue(resolved.regions!, []) === null);

// buildVcPatch — bos-alan kurali + tum alanlar
const extract = {
  companyName: "New Columbia Capital", meetingType: "investor",
  summary: "s", nextSteps: [],
  dealType: "", dealAmount: null, country: "", meetingOwner: "",
  sector: "", icp: "", headcount: null, competitorSolution: "", externalAttended: true,
  investmentVerticals: ["SaaS", "Life Sciences"],
  investmentStages: ["Seed", "Series A"],
  investmentRegions: ["Europe"],
  minTicketSize: 500000, maxTicketSize: 2000000,
  investmentType: "follow-on",
  attendeeProfiles: [],
} satisfies MeetingExtract;

const patch = buildVcPatch(resolved, {}, extract);
check("patch: verticals", patch.investment_vertical_s_ === "SaaS;Life Sciences");
check("patch: stages", patch.investment_stage === "Seed;Series A");
check("patch: region", patch.investment_region === "Europe");
check("patch: min/max ticket",
  patch.minimum_ticket_size === 500000 && patch.maximum_ticket_size === 2000000);
check("patch: type", patch.investment_type === "Follow - On");
check("patch: likelihood asla yazilmaz", !("likelihood" in patch));

// Insan verisi ezilmez: dolu alanlar patch'e girmez
const partial = buildVcPatch(
  resolved,
  { investment_vertical_s_: "Gaming", minimum_ticket_size: "250000" },
  extract,
);
check("patch: dolu alan ezilmez",
  !("investment_vertical_s_" in partial) && !("minimum_ticket_size" in partial));
check("patch: bos alanlar yine dolar", partial.investment_type === "Follow - On");

// Bos cikarim (investor olmayan toplanti) -> bos patch
const empty = buildVcPatch(resolved, {}, {
  ...extract,
  investmentVerticals: [], investmentStages: [], investmentRegions: [],
  minTicketSize: null, maxTicketSize: null, investmentType: "",
});
check("patch: investor-disi toplantida bos", Object.keys(empty).length === 0);

console.log(
  fail === 0
    ? "\nOK: VC kart alanlari duman testi gecti"
    : `\nHATA: ${fail} kontrol basarisiz`,
);
process.exit(fail === 0 ? 0 : 1);
