import {
  extractWebhookTranscriptId,
  safeEqual,
  checkWebhookAuth,
} from "../lib/webhook.js";

// Faz 6 duman testi: webhook yardimcilarini network'e cikmadan dogrular.
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

const ULID = "01KX354T93DF90PKFXQ33XV0C6";

// extractWebhookTranscriptId — cesitli Fireflies govde sekilleri
check("extract meetingId slug::ULID?q", extractWebhookTranscriptId({ meetingId: `Meet-Demo::${ULID}?x=1` }) === ULID);
check("extract transcriptId", extractWebhookTranscriptId({ transcriptId: ULID }) === ULID);
check("extract transcript_id", extractWebhookTranscriptId({ transcript_id: ULID }) === ULID);
check("extract nested data.meetingId", extractWebhookTranscriptId({ data: { meetingId: ULID } }) === ULID);
check("extract bos govde", extractWebhookTranscriptId({}) === "");
check("extract null govde", extractWebhookTranscriptId(null) === "");

// safeEqual
check("safeEqual esit", safeEqual("secret", "secret") === true);
check("safeEqual farkli", safeEqual("secret", "wrong!") === false);
check("safeEqual farkli uzunluk", safeEqual("abc", "abcd") === false);

// checkWebhookAuth
check("auth secret yok -> acik", JSON.stringify(checkWebhookAuth({})) === JSON.stringify({ ok: true, open: true }));
check("auth key eslesiyor", checkWebhookAuth({ secret: "s3cr3t", key: "s3cr3t" }).ok === true);
check("auth header eslesiyor", checkWebhookAuth({ secret: "s3cr3t", header: "s3cr3t" }).ok === true);
check("auth bearer eslesiyor", checkWebhookAuth({ secret: "s3cr3t", bearer: "s3cr3t" }).ok === true);
check("auth yanlis -> red", checkWebhookAuth({ secret: "s3cr3t", key: "nope" }).ok === false);
check("auth eksik -> red", checkWebhookAuth({ secret: "s3cr3t" }).ok === false);

console.log(
  fail === 0
    ? "\nOK: Faz 6 webhook duman testi gecti"
    : `\nHATA: ${fail} kontrol basarisiz`,
);
process.exit(fail === 0 ? 0 : 1);
