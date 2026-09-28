// Gmail okuma katmani — GECMISE DONUK e-posta yedeklemesi icin.
//
// Kimlik: takvim senkronunda kullanilan AYNI service account
// (GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY), bu sefer DOMAIN-WIDE DELEGATION
// ile. JWT'ye `sub` alani eklenince Google token'i "o kullanici adina"
// verir; boylece her ekip uyesinin posta kutusu TEK yerden okunur, kisi
// basi ayri OAuth gerekmez.
//
// Google Workspace admin tarafinda yapilmasi gereken (bir kez):
//   Admin Console > Security > Access and data control > API controls >
//   Domain-wide delegation > Add new
//     Client ID : service account'un OAuth client ID'si
//     Scopes    : https://www.googleapis.com/auth/gmail.readonly
//
// Bu ayar yapilmadan Google 401/403 "unauthorized_client" doner — kod bunu
// anlasilir bir mesaja cevirir (bkz. delegatedToken).
//
// YALNIZ OKUMA: gmail.readonly. Kod hicbir e-posta gondermez/degistirmez.
import crypto from "node:crypto";

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// gcal.ts'teki ile ayni normalizasyon: Vercel env'ine yapistirilan PEM
// kacisli \n icerebiliyor.
function normalizePrivateKey(raw: string): string {
  let k = String(raw || "").trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1);
  }
  k = k.replace(/\\r/g, "").replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(k);
  if (m) {
    const body = m[2].replace(/\s+/g, "");
    const wrapped = body.replace(/(.{64})/g, "$1\n").trim();
    k = `-----BEGIN ${m[1]}-----\n${wrapped}\n-----END ${m[1]}-----\n`;
  }
  return k;
}

/**
 * Taranacak posta kutulari.
 *
 * VALIDFOR_GMAIL_MAILBOXES tanimliysa o kullanilir (virgullu). Tanimli
 * degilse VALIDFOR_OWNER_MAP'teki e-postalar kullanilir — orada zaten seat
 * sahiplerinin listesi var, iki yerde ayni listeyi tutmaya gerek yok.
 */
export function gmailMailboxes(): string[] {
  const explicit = String(process.env.VALIDFOR_GMAIL_MAILBOXES || "").trim();
  const raw = explicit
    ? explicit.split(",")
    : String(process.env.VALIDFOR_OWNER_MAP || "")
        .split(",")
        .map((p) => p.split(":")[0]);
  const out: string[] = [];
  for (const item of raw) {
    const email = String(item || "").trim().toLowerCase();
    if (!email.includes("@")) continue; // ad anahtarlarini ele
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

export function hasServiceAccount(): boolean {
  return Boolean(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY);
}

// Posta kutusu basina token (~1 saat gecerli). Delegasyon kullanici bazli
// oldugu icin onbellek de kullanici bazli.
const tokenCache = new Map<string, { token: string; expMs: number }>();

export function clearGmailTokenCache(): void {
  tokenCache.clear();
}

async function delegatedToken(mailbox: string): Promise<string> {
  const cached = tokenCache.get(mailbox);
  if (cached && Date.now() < cached.expMs) return cached.token;

  const saEmail = process.env.GOOGLE_SA_EMAIL;
  const saKey = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!saEmail || !saKey) {
    throw new Error("GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY gerekli");
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
    "." +
    b64url(
      JSON.stringify({
        iss: saEmail,
        sub: mailbox, // <-- delegasyon: "bu kullanici adina"
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(normalizePrivateKey(saKey));
  const jwt = `${unsigned}.${b64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=" +
      encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      `&assertion=${jwt}`,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    // En sik hata: delegasyon hic kurulmamis ya da scope eklenmemis.
    if (/unauthorized_client/i.test(text)) {
      throw new Error(
        `Gmail delegasyonu yok (${mailbox}): Google Workspace admin > Security > ` +
          "API controls > Domain-wide delegation altina service account'un client " +
          "ID'sini ve https://www.googleapis.com/auth/gmail.readonly scope'unu ekleyin",
      );
    }
    throw new Error(`Gmail token alinamadi (${res.status}): ${text.slice(0, 200)}`);
  }
  const token = String(JSON.parse(text)?.access_token || "");
  if (!token) throw new Error("Gmail token yaniti bos");
  tokenCache.set(mailbox, { token, expMs: Date.now() + 50 * 60_000 });
  return token;
}

async function gapi<T>(mailbox: string, path: string): Promise<T> {
  const token = await delegatedToken(mailbox);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(mailbox)}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gmail ${res.status} ${path.slice(0, 60)}: ${text.slice(0, 160)}`);
  }
  return JSON.parse(text) as T;
}

/** Sorguya uyan mesaj ID'leri (tek sayfa; `max` ust sinir). */
export async function searchMessageIds(
  mailbox: string,
  query: string,
  max = 50,
): Promise<string[]> {
  const qs = `?q=${encodeURIComponent(query)}&maxResults=${Math.min(Math.max(max, 1), 100)}`;
  const json = await gapi<{ messages?: Array<{ id: string }> }>(
    mailbox,
    `/messages${qs}`,
  );
  return (json.messages || []).map((m) => m.id).filter(Boolean);
}

export interface GmailMessage {
  id: string;
  threadId: string;
  /** RFC822 Message-ID basligi — tekillestirme anahtari. */
  rfcId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  dateMs: number;
  /** Duz metin govde (yoksa snippet). */
  body: string;
}

function headerValue(headers: any[], name: string): string {
  const h = (headers || []).find(
    (x) => String(x?.name || "").toLowerCase() === name.toLowerCase(),
  );
  return String(h?.value || "");
}

/** "Ada Lovelace <ada@x.com>, bob@y.com" -> ["ada@x.com","bob@y.com"] */
export function parseAddressList(raw: string): string[] {
  const out: string[] = [];
  for (const part of String(raw || "").split(",")) {
    const m = /<([^>]+)>/.exec(part) || /([^\s<>,;]+@[^\s<>,;]+)/.exec(part);
    const email = String(m?.[1] || "").trim().toLowerCase();
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

/** MIME agacindan ilk text/plain parcayi cikarir (yoksa text/html'i sadelestirir). */
function extractBody(payload: any): string {
  const decode = (data: string): string =>
    Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

  const walk = (node: any, mime: string): string => {
    if (!node) return "";
    if (node.mimeType === mime && node.body?.data) return decode(node.body.data);
    for (const child of node.parts || []) {
      const hit = walk(child, mime);
      if (hit) return hit;
    }
    return "";
  };

  const plain = walk(payload, "text/plain");
  if (plain) return plain;
  const html = walk(payload, "text/html");
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Govde dahil tam mesaj. */
export async function getMessage(mailbox: string, id: string): Promise<GmailMessage> {
  const json = await gapi<any>(mailbox, `/messages/${encodeURIComponent(id)}?format=full`);
  const headers = json?.payload?.headers || [];
  const dateHeader = headerValue(headers, "Date");
  const parsed = dateHeader ? Date.parse(dateHeader) : NaN;
  return {
    id: String(json?.id || id),
    threadId: String(json?.threadId || ""),
    rfcId: headerValue(headers, "Message-ID").replace(/^<|>$/g, ""),
    subject: headerValue(headers, "Subject"),
    from: parseAddressList(headerValue(headers, "From"))[0] || "",
    to: parseAddressList(headerValue(headers, "To")),
    cc: parseAddressList(headerValue(headers, "Cc")),
    dateMs: Number.isFinite(parsed) ? parsed : Number(json?.internalDate) || Date.now(),
    body: (extractBody(json?.payload) || String(json?.snippet || "")).slice(0, 30_000),
  };
}

/**
 * Bir domain icin Gmail sorgusu uretir.
 *
 * Gonderilen + gelen + cc; taslaklar ve spam disarida. `after:` Gmail'in
 * YYYY/MM/DD bicimini ister.
 */
export function domainQuery(domain: string, afterMs: number): string {
  const d = new Date(afterMs);
  const after = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `{from:${domain} to:${domain} cc:${domain}} after:${after} -in:draft -in:spam`;
}
