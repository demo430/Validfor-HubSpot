// Trello karti <-> Fireflies transkripti eslestirme (SAF — network yok).
// Sinyaller: e-posta kesisimi (en guclu) > domain-kok eslesmesi > isim/baslik
// token ortusmesi > tarih yakinligi. Skorlar aciklanabilir (reasons).
import type { TrelloCard } from "./trello.js";
import type { TranscriptListItem } from "./fireflies.js";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const INTERNAL_DOMAINS = new Set(
  (process.env.VALIDFOR_INTERNAL_DOMAINS || "validfor.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);
// Baslik tokenlarinda anlam tasimayan dolgu kelimeler.
const STOPWORDS = new Set([
  "demo", "meeting", "meet", "intro", "call", "and", "the", "of", "with",
  "validfor", "ve", "ile", "x", "gorusme", "toplanti", "sync", "session",
]);

export function extractEmails(text: string): string[] {
  return Array.from(
    new Set((String(text || "").match(EMAIL_RE) || []).map((e) => e.toLowerCase())),
  );
}

export function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // diakritikleri at (Turkce vb.)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export function domainRoot(domain: string): string {
  const parts = String(domain || "").toLowerCase().split(".");
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || "";
}

export interface CardFacts {
  emails: string[]; // kart metnindeki e-postalar
  tokens: string[]; // kart adi + uyeler
  dates: number[]; // due + son aktivite (epoch ms)
}
export function cardFacts(card: TrelloCard): CardFacts {
  const pool = [card.desc, card.name, ...card.customTexts].join("\n");
  const dates: number[] = [];
  for (const d of [card.due, card.dateLastActivity]) {
    if (!d) continue;
    const ms = new Date(d).getTime();
    if (!isNaN(ms)) dates.push(ms);
  }
  return {
    emails: extractEmails(pool),
    tokens: Array.from(new Set([...tokenize(card.name), ...card.memberNames.flatMap(tokenize)])),
    dates,
  };
}

export interface TranscriptFacts {
  id: string;
  title: string;
  dateMs: number | null;
  attendeeEmails: string[]; // harici katilimci e-postalari
  externalDomainRoots: string[]; // harici sirket domain kokleri (free-mail haric)
  titleTokens: string[];
  attendeeNameTokens: string[];
}
export function transcriptFacts(t: TranscriptListItem): TranscriptFacts {
  const emails = Array.from(
    new Set(
      [
        ...(t.meeting_attendees || []).map((a) => a.email || ""),
        ...(t.participants || []),
      ]
        .map((e) => String(e).toLowerCase().trim())
        .filter((e) => e && e.includes("@"))
        .filter((e) => !INTERNAL_DOMAINS.has(e.split("@")[1] || "")),
    ),
  );
  const roots = Array.from(
    new Set(
      emails
        .map((e) => e.split("@")[1] || "")
        .filter((d) => d && !FREE_EMAIL_DOMAINS.has(d))
        .map(domainRoot)
        .filter(Boolean),
    ),
  );
  let dateMs: number | null = null;
  if (t.dateString) {
    const ms = new Date(t.dateString).getTime();
    if (!isNaN(ms)) dateMs = ms;
  }
  if (dateMs == null && t.date != null) {
    const ms = typeof t.date === "number" ? t.date : Number(t.date);
    if (!isNaN(ms)) dateMs = ms;
  }
  return {
    id: t.id,
    title: t.title || "",
    dateMs,
    attendeeEmails: emails,
    externalDomainRoots: roots,
    titleTokens: tokenize(t.title || ""),
    attendeeNameTokens: Array.from(
      new Set(
        (t.meeting_attendees || []).flatMap((a) =>
          tokenize(a.displayName || a.name || ""),
        ),
      ),
    ),
  };
}

export interface MatchScore {
  score: number;
  reasons: string[];
}
export function scoreMatch(card: CardFacts, t: TranscriptFacts): MatchScore {
  let score = 0;
  const reasons: string[] = [];

  // 1) E-posta kesisimi — kesin sinyal
  const emailHits = card.emails.filter((e) => t.attendeeEmails.includes(e));
  if (emailHits.length) {
    score += 100;
    reasons.push(`e-posta eslesti: ${emailHits.join(", ")}`);
  }

  // 2) Kart tokenlari <-> harici domain koku ("amplelogic" ~ amplelogic.com)
  const domainHits = t.externalDomainRoots.filter((r) =>
    card.tokens.some((tok) => tok.includes(r) || r.includes(tok)),
  );
  if (domainHits.length) {
    score += 50;
    reasons.push(`domain koku eslesti: ${domainHits.join(", ")}`);
  }

  // 3) Baslik + katilimci adi token ortusmesi
  const titleHits = card.tokens.filter((tok) => t.titleTokens.includes(tok));
  if (titleHits.length) {
    score += Math.min(15 * titleHits.length, 45);
    reasons.push(`baslik tokenlari: ${titleHits.join(", ")}`);
  }
  const nameHits = card.tokens.filter((tok) => t.attendeeNameTokens.includes(tok));
  if (nameHits.length) {
    score += Math.min(10 * nameHits.length, 30);
    reasons.push(`katilimci adi: ${nameHits.join(", ")}`);
  }

  // 4) Tarih yakinligi (destekleyici)
  if (t.dateMs != null && card.dates.length) {
    const closestDays = Math.min(
      ...card.dates.map((d) => Math.abs(d - t.dateMs!) / 86400000),
    );
    if (closestDays <= 2) {
      score += 20;
      reasons.push(`tarih yakin (${closestDays.toFixed(1)} gun)`);
    } else if (closestDays <= 7) {
      score += 10;
      reasons.push(`tarih ayni hafta (${closestDays.toFixed(1)} gun)`);
    }
  }

  return { score, reasons };
}

export type Confidence = "high" | "medium" | "low" | "none";
export function confidenceOf(score: number, hasEmailHit: boolean): Confidence {
  if (hasEmailHit || score >= 80) return "high";
  if (score >= 45) return "medium";
  if (score >= 25) return "low";
  return "none";
}

export interface CardMatch {
  card: TrelloCard;
  best: { t: TranscriptFacts; score: number; reasons: string[] } | null;
  runnerUp: { t: TranscriptFacts; score: number } | null;
  confidence: Confidence;
  /** En iyi ile ikinci arasindaki fark kucukse insan/Claude incelemesi ister. */
  ambiguous: boolean;
}

export function matchCards(
  cards: TrelloCard[],
  transcripts: TranscriptListItem[],
): CardMatch[] {
  const tf = transcripts.map(transcriptFacts);
  return cards.map((card) => {
    const cf = cardFacts(card);
    const scored = tf
      .map((t) => ({ t, ...scoreMatch(cf, t) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0] && scored[0].score >= 25 ? scored[0] : null;
    const runnerUp = scored[1] && scored[1].score >= 25 ? scored[1] : null;
    const hasEmailHit = Boolean(
      best && best.reasons.some((r) => r.startsWith("e-posta")),
    );
    const confidence: Confidence = best
      ? confidenceOf(best.score, hasEmailHit)
      : "none";
    const ambiguous = Boolean(
      best && runnerUp && best.score - runnerUp.score < 15 && !hasEmailHit,
    );
    return {
      card,
      best: best ? { t: best.t, score: best.score, reasons: best.reasons } : null,
      runnerUp: runnerUp ? { t: runnerUp.t, score: runnerUp.score } : null,
      confidence,
      ambiguous,
    };
  });
}
