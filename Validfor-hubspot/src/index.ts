import { Hono } from "hono";
import { processTranscript } from "../lib/pipeline.js";
import { checkWebhookAuth, extractWebhookTranscriptId, safeEqual } from "../lib/webhook.js";
import { enrichIncomingContacts } from "../lib/enrich-contacts.js";
import { backfillCompanies } from "../lib/backfill.js";
import { sweepStaleDeals, sweepEntryMismatch, DEFAULT_STALE_DAYS } from "../lib/sweep.js";
import { syncScheduledVcDeals, syncCalendarCompanies, syncCalendarDemoDeals } from "../lib/gcal.js";
import { syncCalendlyDemoDeals } from "../lib/calendly.js";

// Validfor Relay — Fireflies toplantilarini Claude (Sonnet 5) uzerinden HubSpot'a
// tasiyan sade Hono uygulamasi. Webhook her seyi SENKRON yapar:
// fetch -> classify -> upsert (+PDF) -> 200.
export const app = new Hono();

// Liveness / health. version + commit: hangi kodun canlida oldugu DISARIDAN
// dogrulanabilsin diye (deploy kontrolu). commit yalnizca Vercel Git
// entegrasyonu deploy'larinda dolar; CLI deploy'da null kalabilir.
app.get("/", (c) =>
  c.json({
    ok: true,
    service: "validfor-relay",
    version: "0.2.0",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
    ts: new Date().toISOString(),
  }),
);

// Fireflies callback dogrulama (GET/HEAD).
app.get("/api/fireflies", (c) =>
  c.json({ ok: true, route: "fireflies-webhook", hint: "POST kullanin" }),
);

// --- Fireflies webhook: toplanti -> HubSpot kaydi (senkron) ---
app.post("/api/fireflies", async (c) => {
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;

  // FAIL-CLOSED: production/Vercel'de secret tanimsizsa istegi ISLEMEYIZ.
  // (Aksi halde env kaybi/yanlis scope'lu preview deploy'da auth sessizce
  // acik kalir ve elindeki herhangi bir transcript ID ile pipeline surulebilir.)
  const isProd = Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
  if (!secret && isProd) {
    console.error("[fireflies] FIREFLIES_WEBHOOK_SECRET tanimsiz — istek reddedildi");
    return c.json({ ok: false, error: "webhook_secret_unset" }, 503);
  }

  // Hono ?key= degerini URL-decode eder ('+' -> bosluk, %2B -> '+').
  // Secret'ta '+' gibi karakterler olursa decode edilmis hal eslesmez; ham
  // (decode edilmemis) degeri de aday olarak karsilastir.
  const rawKey = /[?&]key=([^&#]*)/.exec(c.req.url)?.[1];
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const auth = checkWebhookAuth({
    secret,
    key: c.req.query("key"),
    rawKey,
    header: c.req.header("x-webhook-secret"),
    bearer: bearer || undefined,
  });
  if (!auth.ok) {
    console.warn("[fireflies] webhook auth basarisiz (401)"); // secret'i LOGLAMA
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  if (auth.open) {
    console.warn("[fireflies] FIREFLIES_WEBHOOK_SECRET tanimli degil — auth ACIK (yerel dev)");
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "bad_json" }, 200);
  }

  const id = extractWebhookTranscriptId(body);
  if (!id) return c.json({ ok: true, ignored: "missing_transcript_id" }, 200);

  try {
    const r = await processTranscript(id);
    console.log(`[fireflies] ${id} -> ${r.status} deal=${r.dealId}`);
    return c.json({ ok: true, ...r }, 200);
  } catch (e: any) {
    // Idempotent oldugumuz icin retry guvenli; ama retry firtinasi olmasin diye
    // 200 dondurup hatayi logluyoruz (Vercel loglarinda gorunur).
    console.error(`[fireflies] isleme hatasi (${id}):`, e?.message || e);
    return c.json({ ok: false, transcriptId: id, error: String(e?.message || e).slice(0, 200) }, 200);
  }
});

// Endpoint auth'u (fail-closed): webhook secret'i (?key= / header / Bearer)
// ya da Vercel Cron bearer'i (CRON_SECRET). Yetkiliyse null, degilse 401/503
// yaniti doner. apollo-sync ve backfill-companies ortak kullanir.
function relayAuthError(c: any, tag: string): Response | null {
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const isProd = Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
  if (!secret && !cronSecret && isProd) {
    return c.json({ ok: false, error: "webhook_secret_unset" }, 503);
  }
  const rawKey = /[?&]key=([^&#]*)/.exec(c.req.url)?.[1];
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const auth = checkWebhookAuth({
    secret,
    key: c.req.query("key"),
    rawKey,
    header: c.req.header("x-webhook-secret"),
    bearer: bearer || undefined,
  });
  const cronOk = Boolean(cronSecret && bearer && safeEqual(bearer, cronSecret));
  if (!auth.ok && !cronOk) {
    console.warn(`[${tag}] auth basarisiz (401)`);
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

// GET yalniz ONIZLER (?dry=1) — yazan kosum POST ister. Istisna: Vercel Cron
// yalnizca GET atabildigi icin Bearer CRON_SECRET ile tam kosum yapar. Amac:
// URL'de anahtar tasiyan GET linklerinin (tarayici gecmisi, prefetch, tekrar
// acilan sekme) kazara veri YAZMAMASI. Auth'tan SONRA cagrilmali.
function getWriteGate(c: any): Response | null {
  const dry = ["1", "true"].includes(String(c.req.query("dry") || "").toLowerCase());
  if (dry) return null;
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && bearer && safeEqual(bearer, cronSecret)) return null;
  return c.json(
    { ok: true, hint: "GET yalniz ?dry=1 ile onizler; yazan kosum icin POST kullanin" },
    200,
  );
}

// --- Apollo -> HubSpot outreach senkronu ---
// Outreach baslar baslamaz (contact Apollo listesine girince) HubSpot'a lead
// olarak duser. Tetikleme: Vercel Cron (GET, Authorization: Bearer CRON_SECRET
// otomatik eklenir) ya da elle POST (?key= / Bearer, webhook secret'iyla).
// Vercel'de CRON_SECRET env'ini FIREFLIES_WEBHOOK_SECRET ile ayni degere
// ayarlamak yeterli.
// YON DEGISIKLIGI (kullanici karari): eski davranis Apollo listesini HubSpot'a
// ICE AKTARMAKTI; artik HubSpot'a GELEN contact'lar Apollo People Match ile
// ZENGINLESTIRILIR. URL ayni kaldi (cron-job.org 15dk + Vercel gunluk cron
// yeniden yapilandirma gerektirmesin). Parametreler: ?max=25 (<=50), ?dry=1.
async function runApolloSync(c: any): Promise<Response> {
  const denied = relayAuthError(c, "apollo-sync");
  if (denied) return denied;
  const dry = ["1", "true"].includes(String(c.req.query("dry") || "").toLowerCase());
  const max = Math.min(Math.max(Number(c.req.query("max")) || 25, 1), 50);

  try {
    const r = await enrichIncomingContacts({ max, dry });
    console.log(
      `[apollo-enrich] dry=${dry} scanned=${r.scanned} enriched=${r.enriched} ` +
        `complete=${r.alreadyComplete} notFound=${r.notFound} skipped=${r.skipped} ` +
        `errors=${r.errors} done=${r.done}`,
    );
    return c.json({ ok: true, dry, ...r }, 200);
  } catch (e: any) {
    console.error("[apollo-enrich] hata:", e?.message || e);
    return c.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 200);
  }
}

app.post("/api/apollo-sync", (c) => runApolloSync(c));
// Vercel Cron GET cagirir; gecerli bearer yoksa sadece bilgi doner.
app.get("/api/apollo-sync", (c) => {
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const hasKey = Boolean(c.req.query("key") || bearer || c.req.header("x-webhook-secret"));
  if (!hasKey) {
    return c.json({
      ok: true,
      route: "apollo-sync",
      hint:
        "HubSpot'a gelen contact'lari Apollo ile zenginlestirir. " +
        "x-webhook-secret basligiyla POST; GET ?dry=1 onizler [&max=25]",
    });
  }
  const denied = relayAuthError(c, "apollo-sync");
  if (denied) return denied;
  return getWriteGate(c) ?? runApolloSync(c);
});

// --- Mevcut sirketleri Apollo ile doldur (geriye donuk, partili) ---
// Tarayicidan calistirilabilsin diye GET: once ?key=SECRET&dry=1 ile onizle,
// sonra dry'siz cagir. 60s fonksiyon butcesine sigmak icin her cagri en fazla
// `max` (varsayilan 40) sirketi Apollo'ya sorar; done=false dondukce ayni
// URL'yi tekrar cagir — yalniz bos alanlar doldugu icin tekrarlamak guvenli.
// filled=0 + done=true = her sey tamam.
async function runCompanyBackfill(c: any): Promise<Response> {
  const denied = relayAuthError(c, "backfill-companies");
  if (denied) return denied;
  const dry = ["1", "true"].includes(String(c.req.query("dry") || "").toLowerCase());
  const max = Math.min(Number(c.req.query("max")) || 40, 100);
  try {
    const r = await backfillCompanies({ maxEnrich: max, dry, budgetMs: 45_000 });
    console.log(
      `[backfill-companies] dry=${dry} filled=${r.filled} scanned=${r.scanned} ` +
        `done=${r.done} errors=${r.errors}`,
    );
    return c.json({ ok: true, dry, ...r }, 200);
  } catch (e: any) {
    console.error("[backfill-companies] hata:", e?.message || e);
    return c.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 200);
  }
}
app.post("/api/backfill-companies", (c) => runCompanyBackfill(c));
app.get("/api/backfill-companies", (c) => {
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const hasKey = Boolean(c.req.query("key") || bearer || c.req.header("x-webhook-secret"));
  if (!hasKey) {
    return c.json({
      ok: true,
      route: "backfill-companies",
      hint:
        "x-webhook-secret basligiyla cagir: GET ?dry=1 onizler, POST partiler " +
        "halinde doldurur (done=false ise tekrar cagir)",
    });
  }
  const denied = relayAuthError(c, "backfill-companies");
  if (denied) return denied;
  return getWriteGate(c) ?? runCompanyBackfill(c);
});

// --- Hareketsiz deal supurucusu: Meeting'de 7 gundur hareket yoksa Follow-Up
// (Sales + VC). Vercel Cron gunluk cagirir (GET + Bearer CRON_SECRET); elle:
// ?key=SECRET[&dry=1][&days=7].
async function runStageSweep(c: any): Promise<Response> {
  const denied = relayAuthError(c, "stage-sweep");
  if (denied) return denied;
  const dry = ["1", "true"].includes(String(c.req.query("dry") || "").toLowerCase());
  const days = Math.min(Math.max(Number(c.req.query("days")) || DEFAULT_STALE_DAYS, 1), 60);
  try {
    const r = await sweepStaleDeals({ days, dry });
    console.log(
      `[stage-sweep] dry=${dry} days=${days} checked=${r.checked} moved=${r.moved} ` +
        `fresh=${r.fresh} errors=${r.errors}`,
    );
    // Giris tutarsizligi: Scheduled/Unassigned'da (VC: Contacted) durup islenmis
    // Fireflies toplantisi OLAN deal'lar Meeting'e tasinir (kullanici kurali).
    let entryFix: any = null;
    try {
      entryFix = await sweepEntryMismatch({ dry });
      if (entryFix.moved || entryFix.errors) {
        console.log(
          `[entry-fix] dry=${dry} checked=${entryFix.checked} moved=${entryFix.moved} errors=${entryFix.errors}`,
        );
      }
    } catch (e: any) {
      console.error("[entry-fix] hata:", e?.message || e);
    }
    // Ayni gunluk cron'a bagli ek isler (Vercel Hobby 2 cron siniri): takvimdeki
    // planlanmis VC toplantilari + Calendly demolari deal olarak acilir. Env
    // yoksa ilgili adim sessizce atlanir; hatalari supurucu sonucunu DUSURMEZ.
    const hasGcal =
      Boolean(process.env.GOOGLE_CALENDAR_ID) &&
      Boolean(
        (process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY) ||
          process.env.GOOGLE_CALENDAR_API_KEY,
      );
    let calendar: unknown;
    if (hasGcal) {
      try {
        const cal = await syncScheduledVcDeals({ dry });
        console.log(
          `[calendar-sync] dry=${dry} events=${cal.events} candidates=${cal.candidates} ` +
            `created=${cal.created} existing=${cal.existing} errors=${cal.errors}`,
        );
        calendar = { ok: true, ...cal };
      } catch (e: any) {
        console.error("[calendar-sync] hata:", e?.message || e);
        calendar = { ok: false, error: String(e?.message || e).slice(0, 200) };
      }
    }
    // Takvimden demo deal'lari — Calendly API'sinden BAGIMSIZ yol. Calendly
    // rezervasyonlari organizatorun takvimine dustugu icin, CALENDLY_TOKEN
    // yetkisi bozuk olsa da book edilen demolar CRM'e duser.
    let calendarDemos: unknown;
    if (hasGcal) {
      try {
        const cd = await syncCalendarDemoDeals({ dry });
        console.log(
          `[calendar-demos] dry=${dry} events=${cd.events} candidates=${cd.candidates} ` +
            `created=${cd.created} existing=${cd.existing} errors=${cd.errors}`,
        );
        calendarDemos = { ok: true, ...cd };
      } catch (e: any) {
        console.error("[calendar-demos] hata:", e?.message || e);
        calendarDemos = { ok: false, error: String(e?.message || e).slice(0, 200) };
      }
    }
    let calendly: unknown;
    if (process.env.CALENDLY_TOKEN) {
      try {
        const cl = await syncCalendlyDemoDeals({ dry });
        console.log(
          `[calendly-sync] dry=${dry} events=${cl.events} candidates=${cl.candidates} ` +
            `created=${cl.created} existing=${cl.existing} errors=${cl.errors}`,
        );
        calendly = { ok: true, ...cl };
      } catch (e: any) {
        console.error("[calendly-sync] hata:", e?.message || e);
        calendly = { ok: false, error: String(e?.message || e).slice(0, 200) };
      }
    }
    return c.json(
      {
        ok: true,
        dry,
        days,
        ...r,
        ...(entryFix ? { entryFix } : {}),
        ...(calendar ? { calendar } : {}),
        ...(calendarDemos ? { calendarDemos } : {}),
        ...(calendly ? { calendly } : {}),
      },
      200,
    );
  } catch (e: any) {
    console.error("[stage-sweep] hata:", e?.message || e);
    return c.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 200);
  }
}
app.post("/api/stage-sweep", (c) => runStageSweep(c));
app.get("/api/stage-sweep", (c) => {
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const hasKey = Boolean(c.req.query("key") || bearer || c.req.header("x-webhook-secret"));
  if (!hasKey) {
    return c.json({
      ok: true,
      route: "stage-sweep",
      hint: "x-webhook-secret basligiyla POST; GET ?dry=1 onizler; cron gunluk otomatik calistirir",
    });
  }
  const denied = relayAuthError(c, "stage-sweep");
  if (denied) return denied;
  return getWriteGate(c) ?? runStageSweep(c);
});

// --- Takvim senkronu (elle tetikleme/onizleme): planlanmis VC toplantilari ->
// VC Pipeline'da deal. Gunluk otomatik kosum stage-sweep cron'unun icinde;
// bu route elle calistirmak ve dry onizlemesi icindir.
async function runCalendarSync(c: any): Promise<Response> {
  const denied = relayAuthError(c, "calendar-sync");
  if (denied) return denied;
  const dry = ["1", "true"].includes(String(c.req.query("dry") || "").toLowerCase());
  const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 90);
  // ?past=90: gecmise donuk tek seferlik tarama (varsayilan 7 gunluk guvenlik agi)
  const pastRaw = Number(c.req.query("past"));
  const pastDays = isNaN(pastRaw) ? undefined : Math.min(Math.max(pastRaw, 0), 365);
  // ?until=120: pencereyi "120 gun oncesine kadar" ile bitir — genis taramayi
  // 60 sn fonksiyon siniri + 250 etkinlik sayfasi icin dilimlere boler.
  const untilRaw = Number(c.req.query("until"));
  const untilDays = isNaN(untilRaw) ? undefined : Math.min(Math.max(untilRaw, 0), 365);
  // ?exclude=a.com,b.com: tek seferlik ek dislama (env listesiyle birlesir).
  const extraExclude = String(c.req.query("exclude") || "")
    .split(",")
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean);
  try {
    const r = await syncScheduledVcDeals({ days, pastDays, untilDays, extraExclude, dry });
    console.log(
      `[calendar-sync] dry=${dry} days=${days} past=${pastDays ?? 7} until=${untilDays ?? 0} ` +
        `events=${r.events} candidates=${r.candidates} ` +
        `created=${r.created} existing=${r.existing} errors=${r.errors}`,
    );
    return c.json({ ok: true, dry, days, ...r }, 200);
  } catch (e: any) {
    console.error("[calendar-sync] hata:", e?.message || e);
    return c.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 200);
  }
}
app.post("/api/calendar-sync", (c) => runCalendarSync(c));
app.get("/api/calendar-sync", (c) => {
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const hasKey = Boolean(c.req.query("key") || bearer || c.req.header("x-webhook-secret"));
  if (!hasKey) {
    return c.json({
      ok: true,
      route: "calendar-sync",
      hint: "x-webhook-secret basligiyla POST; GET ?dry=1 onizler; gunluk kosum stage-sweep cron'undadir",
    });
  }
  const denied = relayAuthError(c, "calendar-sync");
  if (denied) return denied;
  return getWriteGate(c) ?? runCalendarSync(c);
});

// --- Calendly senkronu (elle tetikleme/onizleme): planlanmis demolar ->
// Sales Pipeline "Scheduled". Gunluk otomatik kosum stage-sweep cron'unda.
async function runCalendlySync(c: any): Promise<Response> {
  const denied = relayAuthError(c, "calendly-sync");
  if (denied) return denied;
  const dry = ["1", "true"].includes(String(c.req.query("dry") || "").toLowerCase());
  const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 90);
  try {
    const r = await syncCalendlyDemoDeals({ days, dry });
    console.log(
      `[calendly-sync] dry=${dry} days=${days} events=${r.events} candidates=${r.candidates} ` +
        `created=${r.created} existing=${r.existing} errors=${r.errors}`,
    );
    return c.json({ ok: true, dry, days, ...r }, 200);
  } catch (e: any) {
    console.error("[calendly-sync] hata:", e?.message || e);
    return c.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 200);
  }
}
app.post("/api/calendly-sync", (c) => runCalendlySync(c));
app.get("/api/calendly-sync", (c) => {
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const hasKey = Boolean(c.req.query("key") || bearer || c.req.header("x-webhook-secret"));
  if (!hasKey) {
    return c.json({
      ok: true,
      route: "calendly-sync",
      hint: "x-webhook-secret basligiyla POST; GET ?dry=1 onizler; gunluk kosum stage-sweep cron'undadir",
    });
  }
  const denied = relayAuthError(c, "calendly-sync");
  if (denied) return denied;
  return getWriteGate(c) ?? runCalendlySync(c);
});

// --- Takvimdeki TUM sirketler -> HubSpot company (tek seferlik/elle) ---
// VC filtresi olmadan her harici katilimci domain'i icin bul-ya-da-olustur.
// Genis pencereler ?past=N&until=M dilimleriyle taranir (calendar-sync gibi);
// done=false donerse AYNI cagriyi tekrarla (idempotent, zaman butcesi 45s).
async function runCalendarCompanies(c: any): Promise<Response> {
  const denied = relayAuthError(c, "calendar-companies");
  if (denied) return denied;
  const dry = ["1", "true"].includes(String(c.req.query("dry") || "").toLowerCase());
  const days = Math.min(Math.max(Number(c.req.query("days")) || 1, 1), 90);
  const pastRaw = Number(c.req.query("past"));
  const pastDays = isNaN(pastRaw) ? undefined : Math.min(Math.max(pastRaw, 0), 365);
  const untilRaw = Number(c.req.query("until"));
  const untilDays = isNaN(untilRaw) ? undefined : Math.min(Math.max(untilRaw, 0), 365);
  try {
    const r = await syncCalendarCompanies({ days, pastDays, untilDays, dry });
    console.log(
      `[calendar-companies] dry=${dry} past=${pastDays ?? 30} until=${untilDays ?? 0} ` +
        `events=${r.events} domains=${r.domains} created=${r.created} ` +
        `existing=${r.existing} errors=${r.errors} done=${r.done}`,
    );
    return c.json({ ok: true, dry, ...r }, 200);
  } catch (e: any) {
    console.error("[calendar-companies] hata:", e?.message || e);
    return c.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 200);
  }
}
app.post("/api/calendar-companies", (c) => runCalendarCompanies(c));
app.get("/api/calendar-companies", (c) => {
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const hasKey = Boolean(c.req.query("key") || bearer || c.req.header("x-webhook-secret"));
  if (!hasKey) {
    return c.json({
      ok: true,
      route: "calendar-companies",
      hint:
        "Takvimdeki tum harici katilimci sirketlerini HubSpot'a acar. " +
        "x-webhook-secret basligiyla POST; GET ?dry=1 onizler [?past=N&until=M]",
    });
  }
  const denied = relayAuthError(c, "calendar-companies");
  if (denied) return denied;
  return getWriteGate(c) ?? runCalendarCompanies(c);
});

// --- Takvimden DEMO deal'lari (Calendly API'sine bagimli DEGIL) ---
// Calendly rezervasyonlari organizatorun Google Takvim'ine dustugu icin
// deal'lar oradan acilabilir. CALENDLY_TOKEN yetkisi bozuk oldugunda bile
// book edilen demolar CRM'e duser. Gunluk kosum stage-sweep cron'unda.
async function runCalendarDemos(c: any): Promise<Response> {
  const denied = relayAuthError(c, "calendar-demos");
  if (denied) return denied;
  const dry = ["1", "true"].includes(String(c.req.query("dry") || "").toLowerCase());
  const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 90);
  try {
    const r = await syncCalendarDemoDeals({ days, dry });
    console.log(
      `[calendar-demos] dry=${dry} days=${days} events=${r.events} candidates=${r.candidates} ` +
        `created=${r.created} existing=${r.existing} errors=${r.errors}`,
    );
    return c.json({ ok: true, dry, days, ...r }, 200);
  } catch (e: any) {
    console.error("[calendar-demos] hata:", e?.message || e);
    return c.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 200);
  }
}
app.post("/api/calendar-demos", (c) => runCalendarDemos(c));
app.get("/api/calendar-demos", (c) => {
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const hasKey = Boolean(c.req.query("key") || bearer || c.req.header("x-webhook-secret"));
  if (!hasKey) {
    return c.json({
      ok: true,
      route: "calendar-demos",
      hint: "Takvimdeki Calendly/demo rezervasyonlarindan Sales deal acar. x-webhook-secret ile POST; GET ?dry=1 onizler",
    });
  }
  const denied = relayAuthError(c, "calendar-demos");
  if (denied) return denied;
  return getWriteGate(c) ?? runCalendarDemos(c);
});

export default app;
