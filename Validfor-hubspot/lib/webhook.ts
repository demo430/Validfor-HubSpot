import crypto from "node:crypto";
import { extractTranscriptId } from "./fireflies.js";

// Fireflies webhook govdesinden transcript ID cikarir (cesitli alan adlari).
export function extractWebhookTranscriptId(body: any): string {
  if (!body || typeof body !== "object") return "";
  const cand =
    body.meetingId ??
    body.transcriptId ??
    body.transcript_id ??
    body.id ??
    (body.transcript && body.transcript.id) ??
    (body.data && (body.data.meetingId || body.data.transcriptId));
  return cand ? extractTranscriptId(String(cand)) : "";
}

// Sabit-zamanli string karsilastirma (timing side-channel'a karsi).
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export interface WebhookAuthInput {
  secret?: string;
  key?: string; // ?key= (URL-decode edilmis)
  rawKey?: string; // ?key= (ham, decode edilmemis — '+'/%XX iceren secret'lar icin)
  header?: string; // x-webhook-secret
  bearer?: string; // Authorization: Bearer <...>
}

// secret tanimliysa: ?key= / rawKey / x-webhook-secret / Bearer'dan biri eslesmeli.
// secret yoksa: izin ver (dev) ama `open: true` -> caller uyari loglar.
// NOT: production fail-closed karari caller'da (src/index.ts) — burada degil.
export function checkWebhookAuth(input: WebhookAuthInput): {
  ok: boolean;
  open: boolean;
} {
  const secret = input.secret || "";
  if (!secret) return { ok: true, open: true };
  const provided = [input.key, input.rawKey, input.header, input.bearer].filter(
    (v): v is string => Boolean(v),
  );
  const ok = provided.some((p) => safeEqual(p, secret));
  return { ok, open: false };
}
