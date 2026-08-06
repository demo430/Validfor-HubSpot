// Claude "beyin": transkriptten temiz CRM verisi cikarir (tek cagri, yapisal JSON).
// Model: claude-sonnet-5. Structured Outputs (output_config.format) ile cikti
// semaya uyar; JSON.parse guvenli.
import Anthropic from "@anthropic-ai/sdk";
import type { Transcript } from "./fireflies.js";

// Contact zenginlestirme enum degerleri — HubSpot property secenekleriyle BIREBIR.
export const ROLE_IN_VALIDATION = [
  "quality_assurance", "validation_professional", "it_department",
  "system_owner", "project_manager", "digital_transformation_team",
] as const;
export const PREFERRED_VALIDATION_MODULE = [
  "change_management", "deviation_management", "test_management",
  "periodic_review_management", "ai_validation_assistant",
] as const;
export const VALIDATION_BUDGET_RANGE = [
  "less_than_50k", "50k_100k", "100k_250k", "more_than_250k",
] as const;
export const AI_ADOPTION_READINESS = [
  "exploring_options", "ready_to_adopt", "already_using_ai",
] as const;
// Deal enum degerleri — HubSpot property secenekleriyle BIREBIR (bosluk/buyuk harf dahil).
export const ICP_OPTIONS = ["Pharma Manufacturing", "BioTech", "Medical Device"] as const;
// VC kartindaki "Investment Type" secenekleri kanonik token olarak cikarilir;
// HubSpot'taki gercek secenek degerine eslemeyi vcfields yapar (etiket "Co - Lead"
// gibi bosluklu olabilir — ic deger portalda ne olursa olsun normalize eslesir).
export const INVESTMENT_TYPE_OPTIONS = ["lead", "co-lead", "follow-on"] as const;

/** Harici katilimci profili — yalnizca transkriptte ACIKCA desteklenen alanlar dolu. */
export interface AttendeeProfile {
  /** Katilimcinin e-postasi (transkript katilimci listesinden, kucuk harf). */
  email: string;
  firstName: string;
  lastName: string;
  /** Yalnizca acikca soylendiyse/yazildiysa. */
  phone: string;
  roleInValidation: string;
  preferredValidationModule: string;
  validationBudgetRange: string;
  aiAdoptionReadiness: string;
}

export interface MeetingExtract {
  /** Karsi tarafin (harici) sirket adi — Validfor DEGIL. Bilinmiyorsa "". */
  companyName: string;
  /** Toplanti tipi. */
  meetingType: string;
  /** CRM notu icin temiz, 2-4 cumlelik Ingilizce ozet. */
  summary: string;
  /** Somut sonraki adimlar / aksiyon maddeleri. */
  nextSteps: string[];
  /** Yeni musteri mi mevcut musteri mi? Bilinmiyorsa "". */
  dealType: "" | "newbusiness" | "existingbusiness";
  /** Yillik sozlesme degeri — YALNIZCA acikca konusulduysa (USD). Yoksa null. */
  dealAmount: number | null;
  /** Harici sirketin ulkesi — yalnizca transkriptten belliyse. Yoksa "". */
  country: string;
  /**
   * Toplantiyi YONETEN Validfor ekip uyesinin tam adi (konusmacilardan).
   * demo@/connect@ gibi ortak hesaplar KISI DEGILDIR. Belirsizse "".
   */
  meetingOwner: string;
  /** Harici sirketin sektoru (kisa Ingilizce; or. "Pharmaceuticals", "CDMO"). Belirsizse "". */
  sector: string;
  /** Ideal musteri profili sinifi (HubSpot enum) — belli degilse "". */
  icp: string;
  /** Sirket calisan sayisi — YALNIZCA acikca soylendiyse. Yoksa null. */
  headcount: number | null;
  /** Su an kullandiklari cozum/rakip arac (or. "Veeva", "Kneat", "Excel/paper-based"). Belirsizse "". */
  competitorSolution: string;
  /**
   * Harici taraftan EN AZ BIR kisi toplantiya gercekten katildi mi?
   * false YALNIZCA acikca kimse gelmediyse (bos/sessiz kayit, yalniz bot
   * ve/veya yalniz Validfor ekibi bekliyor). Belirsizse true (varsayilan).
   */
  externalAttended: boolean;
  // --- VC yatirim profili (yalniz meetingType=investor toplantilarinda dolar) ---
  /** Fonun yatirim yaptigi dikeyler (or. "SaaS", "Life Sciences"). Diger toplantilarda []. */
  investmentVerticals: string[];
  /** Fonun yatirim asamalari (or. "Pre-Seed", "Seed", "Series A"). */
  investmentStages: string[];
  /** Fonun cografi odagi (or. "Europe", "North America", "MENA"). */
  investmentRegions: string[];
  /** Minimum cek/ticket buyuklugu (USD) — YALNIZCA acik rakam soylendiyse. Yoksa null. */
  minTicketSize: number | null;
  /** Maksimum cek/ticket buyuklugu (USD) — YALNIZCA acik rakam soylendiyse. Yoksa null. */
  maxTicketSize: number | null;
  /** Fonun turdaki rolu — lead / co-lead / follow-on. Belirsizse "". */
  investmentType: string;
  /** Harici katilimci profilleri (isim/telefon/validasyon alanlari). */
  attendeeProfiles: AttendeeProfile[];
}

const MODEL = "claude-sonnet-5";
const MAX_TRANSCRIPT_CHARS = 40000; // ~10K token: uzun toplantilarda maliyeti sinirla

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    companyName: {
      type: "string",
      description:
        "Name of the EXTERNAL company in the meeting (the other party, NOT Validfor). " +
        "Best human-readable guess from the transcript or attendee email domains. Empty string if truly unknown.",
    },
    meetingType: {
      type: "string",
      enum: ["demo", "intro", "sales", "partnership", "investor", "internal", "support", "other"],
      description:
        "Best-fit category for this meeting. Use 'investor' ONLY for fundraising/VC " +
        "conversations (venture capital, angels, term sheets, investment rounds) — " +
        "NOT for customer or partnership meetings.",
    },
    summary: {
      type: "string",
      description:
        "A clean, factual 2-4 sentence summary of the meeting in ENGLISH, suitable for a CRM note. No preamble.",
    },
    nextSteps: {
      type: "array",
      items: { type: "string" },
      description: "Concrete action items / next steps in English. Empty array if none.",
    },
    dealType: {
      type: "string",
      enum: ["", "newbusiness", "existingbusiness"],
      description:
        "newbusiness if the external party is a NEW prospect; existingbusiness if they are " +
        "clearly an EXISTING customer expanding/renewing. Empty string if unclear.",
    },
    dealAmount: {
      type: ["number", "null"],
      description:
        "Annual contract / deal value in USD, ONLY if a concrete figure was explicitly " +
        "discussed in the meeting. null otherwise. Never guess or estimate.",
    },
    country: {
      type: "string",
      description:
        "Country of the EXTERNAL company (HQ or attendee location) ONLY if evident from the " +
        "transcript (mentioned locations, offices, phone codes). English name, e.g. " +
        "\"Germany\", \"Türkiye\", \"United States\". Empty string if unclear.",
    },
    meetingOwner: {
      type: "string",
      description:
        "Full name of the VALIDFOR (internal) team member who actually LED/ran this meeting, " +
        "taken from the transcript speakers (e.g. the person demonstrating the product). " +
        "Never a shared mailbox name like 'Demo' or 'Connect'; never an external attendee. " +
        "Empty string if unclear.",
    },
    sector: {
      type: "string",
      description:
        "Short English sector/industry of the EXTERNAL company (e.g. \"Pharmaceuticals\", " +
        "\"CDMO\", \"Biotechnology\", \"Consulting\", \"Medical Devices\"). Empty if unclear.",
    },
    icp: {
      type: "string",
      enum: ["", ...ICP_OPTIONS],
      description:
        "Ideal customer profile class of the external company. Empty if it does not clearly " +
        "fit one of the options.",
    },
    headcount: {
      type: ["number", "null"],
      description:
        "Employee count of the external company, ONLY if explicitly mentioned in the meeting " +
        "(e.g. \"we are 2000 people\"). null otherwise. Never estimate.",
    },
    competitorSolution: {
      type: "string",
      description:
        "The validation solution/tool the external company currently uses, if mentioned " +
        "(e.g. \"Veeva\", \"Kneat\", \"ValGenesis\", \"Excel/paper-based\"). Empty if not discussed.",
    },
    externalAttended: {
      type: "boolean",
      description:
        "false ONLY if it is clear that NO external participant actually joined the meeting " +
        "(empty/silent recording, only the notetaker bot present, or only Validfor team members " +
        "waiting/talking among themselves). true when externals spoke or when unclear.",
    },
    investmentVerticals: {
      type: "array",
      items: { type: "string" },
      description:
        "ONLY for investor meetings: verticals/sectors the FUND says it invests in " +
        "(e.g. \"SaaS\", \"Life Sciences\", \"Deep Tech\"). Empty array for all other " +
        "meeting types or when not discussed.",
    },
    investmentStages: {
      type: "array",
      items: { type: "string" },
      description:
        "ONLY for investor meetings: investment stages the fund writes checks for " +
        "(e.g. \"Pre-Seed\", \"Seed\", \"Series A\"). Empty array otherwise.",
    },
    investmentRegions: {
      type: "array",
      items: { type: "string" },
      description:
        "ONLY for investor meetings: geographies the fund invests in " +
        "(e.g. \"Europe\", \"North America\", \"MENA\", \"Global\"). Empty array otherwise.",
    },
    minTicketSize: {
      type: ["number", "null"],
      description:
        "ONLY for investor meetings: the fund's MINIMUM check/ticket size in USD, ONLY if " +
        "an explicit figure was stated (e.g. \"we write 500K to 2M checks\" -> 500000). " +
        "null otherwise. Never estimate.",
    },
    maxTicketSize: {
      type: ["number", "null"],
      description:
        "ONLY for investor meetings: the fund's MAXIMUM check/ticket size in USD, if " +
        "an explicit figure was stated (e.g. \"we write 500K to 2M checks\" -> 2000000). " +
        "If the fund states ONLY an AVERAGE ticket size, put that average value here. " +
        "null otherwise. Never estimate.",
    },
    investmentType: {
      type: "string",
      enum: ["", ...INVESTMENT_TYPE_OPTIONS],
      description:
        "ONLY for investor meetings: whether the fund typically LEADS rounds ('lead'), " +
        "co-leads ('co-lead') or follows other investors ('follow-on'), if stated. " +
        "Empty string if unclear or not an investor meeting.",
    },
    attendeeProfiles: {
      type: "array",
      description:
        "One entry per EXTERNAL attendee (never @validfor.com). Fill a field ONLY when the " +
        "transcript clearly supports it; otherwise empty string. Do not invent.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          email: {
            type: "string",
            description: "Attendee email exactly as in the attendee list, lowercase.",
          },
          firstName: { type: "string", description: "Given name. Empty if unknown." },
          lastName: { type: "string", description: "Family name. Empty if unknown." },
          phone: {
            type: "string",
            description: "Phone number ONLY if explicitly stated/shared. Empty otherwise.",
          },
          roleInValidation: {
            type: "string",
            enum: ["", ...ROLE_IN_VALIDATION],
            description: "Attendee's role in validation processes, if evident.",
          },
          preferredValidationModule: {
            type: "string",
            enum: ["", ...PREFERRED_VALIDATION_MODULE],
            description: "Module the attendee showed most interest in, if evident.",
          },
          validationBudgetRange: {
            type: "string",
            enum: ["", ...VALIDATION_BUDGET_RANGE],
            description: "Stated/implied validation budget range (USD/yr), only if discussed.",
          },
          aiAdoptionReadiness: {
            type: "string",
            enum: ["", ...AI_ADOPTION_READINESS],
            description: "Attendee's/company's AI adoption stance, if evident.",
          },
        },
        required: [
          "email", "firstName", "lastName", "phone", "roleInValidation",
          "preferredValidationModule", "validationBudgetRange", "aiAdoptionReadiness",
        ],
      },
    },
  },
  required: [
    "companyName", "meetingType", "summary", "nextSteps",
    "dealType", "dealAmount", "country", "meetingOwner",
    "sector", "icp", "headcount", "competitorSolution", "externalAttended",
    "investmentVerticals", "investmentStages", "investmentRegions",
    "minTicketSize", "maxTicketSize", "investmentType",
    "attendeeProfiles",
  ],
};

function serializeTranscript(t: Transcript): string {
  const lines: string[] = [];
  lines.push(`Title: ${t.title || "(untitled)"}`);
  if (t.dateString) lines.push(`Date: ${t.dateString}`);
  if (t.duration != null && !isNaN(Number(t.duration))) {
    lines.push(`Duration: ${Math.round(Number(t.duration))} min`);
  }

  const attendees = (t.meeting_attendees || [])
    .map((a) => [a.displayName || a.name, a.email].filter(Boolean).join(" "))
    .filter(Boolean);
  if (attendees.length) lines.push(`Attendees: ${attendees.join("; ")}`);

  const s = t.summary || {};
  if (s.overview) lines.push(`\nFireflies overview:\n${s.overview}`);
  else if (s.short_summary) lines.push(`\nFireflies summary:\n${s.short_summary}`);
  const actions = Array.isArray(s.action_items)
    ? s.action_items.join("\n")
    : s.action_items;
  if (actions) lines.push(`\nFireflies action items:\n${actions}`);

  const sentences = t.sentences || [];
  if (sentences.length) {
    let body = sentences
      .map((x) => `${x.speaker_name || "Speaker"}: ${x.text || ""}`)
      .join("\n");
    if (body.length > MAX_TRANSCRIPT_CHARS) {
      body = body.slice(0, MAX_TRANSCRIPT_CHARS);
      // slice UTF-16 code-unit keser: sinira denk gelen emoji/astral karakter
      // yarim surrogate birakir ve API JSON'i reddeder -> onar.
      if (!body.isWellFormed()) body = body.toWellFormed();
      body += "\n… [transcript truncated]";
    }
    lines.push(`\nTranscript:\n${body}`);
  }
  return lines.join("\n");
}

// Saf (network yok) — testlerde dogrulanabilir.
export function buildExtractPrompt(t: Transcript): string {
  return (
    `You extract clean CRM data from a meeting transcript.\n\n` +
    `CONTEXT: "Validfor" is OUR company (internal). Attendees with @validfor.com emails ` +
    `(e.g. demo@validfor.com, connect@validfor.com) are internal. The EXTERNAL company is the other party.\n\n` +
    `Return the external company name, the meeting type, a clean 2-4 sentence English summary ` +
    `for a CRM note, and concrete next steps. ` +
    `Also extract CRM enrichment: dealType (new vs existing customer), ` +
    `dealAmount (ONLY an explicitly discussed figure), company country, the Validfor team member ` +
    `who LED the meeting (meetingOwner — a real person from the speakers, never a shared account), ` +
    `the company's sector, ICP class, headcount (only if stated), the competitor/current solution ` +
    `they use, and per-EXTERNAL-attendee ` +
    `profiles (names, phone, role in validation, preferred module, budget range, AI readiness). ` +
    `For INVESTOR meetings ONLY, also extract the fund's investment profile: the verticals, ` +
    `stages and regions they invest in, their min/max ticket size in USD (only explicit ` +
    `figures), and whether they lead/co-lead/follow-on rounds — leave all of these ` +
    `empty/null for every other meeting type. ` +
    `Base everything strictly on the content below; do not invent facts — leave fields empty/null ` +
    `when the transcript does not clearly support them. If the transcript is empty, infer what you ` +
    `can from the title and attendees. ` +
    `Exception for meetingType: even with an empty transcript, if the external attendees are ` +
    `clearly from an investment firm (domain/company like "...capital", "...ventures", "...vc") ` +
    `and the meeting is an intro/pitch with founders, classify it as "investor".\n\n` +
    `=== MEETING ===\n${serializeTranscript(t)}`
  );
}

export async function classifyMeeting(
  t: Transcript,
  opts: { apiKey?: string } = {},
): Promise<MeetingExtract> {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  // Erken ve net hata: SDK anahtar yokken kurulur, istek aninda kriptik
  // "Could not resolve authentication method" verir — bunu loglarda ayirt
  // edilebilir yapalim (Vercel'de env unutulursa %100 toplanti kaybi demek).
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY tanimli degil");
  // Zaman butcesi: SDK varsayilani 10 dk + 2 retry — Vercel maxDuration 60s'i
  // asar, fonksiyon orta yerde oldurulur. 20s/deneme + 1 retry butceye sigar
  // (tipik cikarim 5-10s; thinking kapali).
  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000, // katilimci profilleri eklendi — genis toplantilarda yer olsun
    thinking: { type: "disabled" }, // duz cikarim — hiz + maliyet
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: buildExtractPrompt(t) }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  if (res.stop_reason === "max_tokens") {
    // Kesik JSON'u parse etmeye calismak yaniltici hata verir; net soyle.
    throw new Error("Claude yaniti max_tokens ile kesildi (cikti cok uzun)");
  }
  const textBlock = res.content.find((b) => b.type === "text");
  const raw = textBlock && "text" in textBlock ? textBlock.text : "";
  let parsed: Partial<MeetingExtract>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude yaniti JSON degil: ${String(raw).slice(0, 300)}`);
  }
  const okEnum = <T extends readonly string[]>(v: unknown, allowed: T): string =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? v : "";
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((s) => String(s || "").trim()).filter(Boolean) : [];
  const posNum = (v: unknown): number | null =>
    typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : null;
  const profiles: AttendeeProfile[] = Array.isArray(parsed.attendeeProfiles)
    ? parsed.attendeeProfiles
        .filter((p: any) => p && typeof p.email === "string" && p.email.includes("@"))
        .map((p: any) => ({
          email: String(p.email).toLowerCase().trim(),
          firstName: String(p.firstName || "").trim(),
          lastName: String(p.lastName || "").trim(),
          phone: String(p.phone || "").trim(),
          roleInValidation: okEnum(p.roleInValidation, ROLE_IN_VALIDATION),
          preferredValidationModule: okEnum(p.preferredValidationModule, PREFERRED_VALIDATION_MODULE),
          validationBudgetRange: okEnum(p.validationBudgetRange, VALIDATION_BUDGET_RANGE),
          aiAdoptionReadiness: okEnum(p.aiAdoptionReadiness, AI_ADOPTION_READINESS),
        }))
    : [];
  return {
    companyName: parsed.companyName || "",
    meetingType: parsed.meetingType || "other",
    summary: parsed.summary || "",
    nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
    dealType:
      parsed.dealType === "newbusiness" || parsed.dealType === "existingbusiness"
        ? parsed.dealType
        : "",
    dealAmount:
      typeof parsed.dealAmount === "number" && isFinite(parsed.dealAmount) && parsed.dealAmount > 0
        ? parsed.dealAmount
        : null,
    country: String(parsed.country || "").trim(),
    meetingOwner: String(parsed.meetingOwner || "").trim(),
    sector: String(parsed.sector || "").trim(),
    icp: okEnum(parsed.icp, ICP_OPTIONS),
    headcount: posNum(parsed.headcount),
    competitorSolution: String(parsed.competitorSolution || "").trim(),
    externalAttended: parsed.externalAttended !== false, // belirsizse true

    investmentVerticals: strList(parsed.investmentVerticals),
    investmentStages: strList(parsed.investmentStages),
    investmentRegions: strList(parsed.investmentRegions),
    minTicketSize: posNum(parsed.minTicketSize),
    maxTicketSize: posNum(parsed.maxTicketSize),
    investmentType: okEnum(parsed.investmentType, INVESTMENT_TYPE_OPTIONS),
    attendeeProfiles: profiles,
  };
}

// --- Bosluk yakalayici: fon profili odakli DAR ikinci cikarim ---
// Genel cikarim (classifyMeeting) 20 alani birden isterken fon profili
// detaylarini kacirabilir. Bu dar gecis YALNIZCA fonun kendi profilini sorar;
// upsert 5b, genel cikarimin bos biraktigi alanlar icin cagirir ve yalnizca
// bos alanlari tamamlar. Kural ayni: soylenmemis sey uydurulmaz.
export interface FundProfile {
  investmentVerticals: string[];
  investmentStages: string[];
  investmentRegions: string[];
  minTicketSize: number | null;
  maxTicketSize: number | null;
  investmentType: string;
}

const FUND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    investmentVerticals: {
      type: "array", items: { type: "string" },
      description: "Verticals/thesis the FUND says it invests in. Empty if not stated.",
    },
    investmentStages: {
      type: "array", items: { type: "string" },
      description: "Stages the FUND invests in (e.g. Seed, Series A). Empty if not stated.",
    },
    investmentRegions: {
      type: "array", items: { type: "string" },
      description: "Geographic focus of the FUND. Empty if not stated.",
    },
    minTicketSize: {
      type: ["number", "null"],
      description: "Minimum check size in USD, ONLY if explicitly stated. An average ticket is NOT a min.",
    },
    maxTicketSize: {
      type: ["number", "null"],
      description:
        "Maximum check size in USD if explicitly stated. If the fund states ONLY an AVERAGE " +
        "ticket size, put that average here (kural: ortalama bilet -> maksimuma yazilir).",
    },
    investmentType: {
      type: "string", enum: ["", ...INVESTMENT_TYPE_OPTIONS],
      description: "Whether the fund leads, co-leads or follows on, as stated.",
    },
  },
  required: [
    "investmentVerticals", "investmentStages", "investmentRegions",
    "minTicketSize", "maxTicketSize", "investmentType",
  ],
};

export async function extractFundProfile(
  t: Transcript,
  opts: { apiKey?: string } = {},
): Promise<FundProfile> {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY tanimli degil");
  const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    thinking: { type: "disabled" },
    output_config: { format: { type: "json_schema", schema: FUND_SCHEMA } },
    messages: [
      {
        role: "user",
        content:
          `You are extracting the INVESTOR FUND's profile from a fundraising meeting transcript. ` +
          `Focus ONLY on what the FUND's own representatives state about their fund: investment ` +
          `verticals/thesis, stages, geographic focus, minimum/maximum check size in USD, and whether ` +
          `they lead, co-lead or follow on. Ignore everything about the startup pitching itself. ` +
          `Include ONLY explicitly stated facts; otherwise leave fields empty/null. If the fund ` +
          `states ONLY an AVERAGE ticket size, put that value in maxTicketSize (leave min null); ` +
          `an average is never a minimum.\n\n` +
          `=== MEETING ===\n${serializeTranscript(t)}`,
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);
  if (res.stop_reason === "max_tokens") {
    throw new Error("fon profili yaniti max_tokens ile kesildi");
  }
  const block = res.content.find((b) => b.type === "text");
  let parsed: any = {};
  try {
    parsed = JSON.parse(block && "text" in block ? block.text : "{}");
  } catch {
    /* bos profil doner */
  }
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && isFinite(v) && v > 0 ? v : null;
  return {
    investmentVerticals: arr(parsed.investmentVerticals),
    investmentStages: arr(parsed.investmentStages),
    investmentRegions: arr(parsed.investmentRegions),
    minTicketSize: num(parsed.minTicketSize),
    maxTicketSize: num(parsed.maxTicketSize),
    investmentType:
      typeof parsed.investmentType === "string" &&
      (INVESTMENT_TYPE_OPTIONS as readonly string[]).includes(parsed.investmentType)
        ? parsed.investmentType
        : "",
  };
}
