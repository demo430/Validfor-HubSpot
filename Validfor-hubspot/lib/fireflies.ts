// Fireflies GraphQL'den transkript cekme.
// Dokuman: https://docs.fireflies.ai/graphql-api/query/transcript

export const FIREFLIES_GRAPHQL = "https://api.fireflies.ai/graphql";

export interface TranscriptSummary {
  overview?: string | null;
  short_summary?: string | null;
  action_items?: string | string[] | null;
  keywords?: string[] | null;
  bullet_gist?: string | null;
}
export interface MeetingAttendee {
  displayName?: string | null;
  email?: string | null;
  name?: string | null;
}
export interface Sentence {
  speaker_name?: string | null;
  text?: string | null;
  start_time?: number | null;
}
export interface Transcript {
  id: string;
  title?: string | null;
  dateString?: string | null;
  date?: number | string | null;
  duration?: number | null;
  transcript_url?: string | null;
  meeting_link?: string | null;
  host_email?: string | null;
  organizer_email?: string | null;
  participants?: string[] | null;
  meeting_attendees?: MeetingAttendee[] | null;
  speakers?: Array<{ name?: string | null }> | null;
  sentences?: Sentence[] | null;
  summary?: TranscriptSummary | null;
}

// Genis alan seti (ozet + katilimcilar dahil).
const FULL_QUERY = `
query Transcript($transcriptId: String!) {
  transcript(id: $transcriptId) {
    id
    title
    dateString
    date
    duration
    transcript_url
    meeting_link
    host_email
    organizer_email
    participants
    meeting_attendees { displayName email name }
    speakers { name }
    sentences { speaker_name text start_time }
    summary { overview short_summary action_items keywords bullet_gist }
  }
}`;

// Dusuk planlarda bazi alanlar erisilemeyebilir; o durumda bu minimal sete duseriz.
const MIN_QUERY = `
query Transcript($transcriptId: String!) {
  transcript(id: $transcriptId) {
    id
    title
    dateString
    date
    duration
    transcript_url
    meeting_link
    speakers { name }
    sentences { speaker_name text start_time }
  }
}`;

// Fireflies ID'sini serbest girdiden ayiklar. Kabul edilen formlar:
//   "01KX...ULID"                                  -> aynen
//   "Slug-Baslik::01KX...ULID"                     -> "::" sonrasi
//   "Slug::01KX...ULID?channelSource=all"          -> query atilir, "::" sonrasi
//   "https://app.fireflies.ai/view/Slug::01KX..."  -> son path segmenti, sonra ustekiler
// Fireflies GraphQL yalnizca ULID kismini kabul eder (slug/URL 404 verir).
export function extractTranscriptId(input: string): string {
  if (!input) return "";
  let s = String(input).trim();
  if (/^https?:\/\//i.test(s)) {
    const slash = s.lastIndexOf("/");
    if (slash !== -1) s = s.slice(slash + 1);
  }
  const q = s.indexOf("?");
  if (q !== -1) s = s.slice(0, q);
  const sep = s.lastIndexOf("::");
  if (sep !== -1) s = s.slice(sep + 2);
  return s.trim();
}

async function runQuery(
  query: string,
  transcriptId: string,
  key: string,
): Promise<{ res: Response; json: any }> {
  const res = await fetch(FIREFLIES_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, variables: { transcriptId } }),
    // Dar butce: FULL+MIN pespese kossa bile Vercel 60s icinde kalinsin.
    signal: AbortSignal.timeout(12000),
  });
  let json: any = {};
  try {
    json = await res.json();
  } catch {
    /* noop */
  }
  return { res, json };
}

export async function fetchTranscript(
  transcriptId: string,
  apiKey?: string,
): Promise<Transcript> {
  const key = apiKey || process.env.FIREFLIES_API_KEY;
  if (!key) throw new Error("FIREFLIES_API_KEY tanimli degil");
  const id = extractTranscriptId(transcriptId);
  if (!id) throw new Error("transcriptId bos");

  // 1) Genis sorgu
  let { res, json } = await runQuery(FULL_QUERY, id, key);
  if (res.ok && json?.data?.transcript) return json.data.transcript as Transcript;

  // 2) Minimal sorguya YALNIZCA GraphQL alan/dogrulama hatasinda dus (dusuk plan
  // bazi alanlari kapatir -> json.errors doner). 401/403/429/5xx'te ikinci
  // sorgu ayni sekilde basarisiz olur ve rate limit altinda cagri sayisini
  // ikiye katlar -> direkt firlat.
  const gqlFieldError = Boolean(json?.errors) && (res.ok || res.status === 400);
  const errMsg = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
  if (!gqlFieldError) {
    throw new Error(`Fireflies transcript cekilemedi (${id}): ${errMsg}`);
  }
  ({ res, json } = await runQuery(MIN_QUERY, id, key));
  if (res.ok && json?.data?.transcript) return json.data.transcript as Transcript;

  const finalErr = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
  throw new Error(
    `Fireflies transcript cekilemedi (${id}). Ilk: ${errMsg} | Son: ${finalErr}`,
  );
}

// Kanonik Fireflies gorunum linki — tum pipeline'in eslesme anahtari (fireflies_link).
export function viewUrl(id: string): string {
  return `https://app.fireflies.ai/view/${id}`;
}

// --- Transkript LISTESI (Trello eslestirme / backfill icin) ---
// Hafif alan seti: cumleler YOK (liste cagrisinda gereksiz agirlik).
export interface TranscriptListItem {
  id: string;
  title?: string | null;
  dateString?: string | null;
  date?: number | string | null;
  duration?: number | null;
  organizer_email?: string | null;
  participants?: string[] | null;
  meeting_attendees?: MeetingAttendee[] | null;
}

const LIST_QUERY = `
query Transcripts($limit: Int, $skip: Int) {
  transcripts(limit: $limit, skip: $skip) {
    id
    title
    dateString
    date
    duration
    organizer_email
    participants
    meeting_attendees { displayName email name }
  }
}`;

export async function fetchTranscriptList(opts: {
  apiKey?: string;
  max?: number;
} = {}): Promise<TranscriptListItem[]> {
  const key = opts.apiKey || process.env.FIREFLIES_API_KEY;
  if (!key) throw new Error("FIREFLIES_API_KEY tanimli degil");
  const max = opts.max ?? 200;
  const out: TranscriptListItem[] = [];
  const PAGE = 50; // Fireflies limit ustu 50
  for (let skip = 0; skip < max; skip += PAGE) {
    const res = await fetch(FIREFLIES_GRAPHQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: LIST_QUERY,
        variables: { limit: Math.min(PAGE, max - skip), skip },
      }),
      signal: AbortSignal.timeout(15000),
    });
    let json: any = {};
    try {
      json = await res.json();
    } catch {
      /* noop */
    }
    const page: TranscriptListItem[] = json?.data?.transcripts || [];
    if (!res.ok || json?.errors) {
      throw new Error(
        `Fireflies transkript listesi cekilemedi: ${
          json?.errors ? JSON.stringify(json.errors).slice(0, 300) : `HTTP ${res.status}`
        }`,
      );
    }
    out.push(...page);
    if (page.length < PAGE) break; // son sayfa
  }
  return out;
}
