// Hareketsiz deal supurucusu duman testi (network YOK): son-hareket hesabi +
// bayatlama esigi + endpoint auth zinciri.
process.env.FIREFLIES_WEBHOOK_SECRET = "test-secret";
process.env.NODE_ENV = "production"; // fail-closed yollarini da test et

import { lastActivityMs, isStale, SWEEP_TARGETS } from "../lib/sweep.js";
import { STAGE, VC_STAGE } from "../lib/upsert.js";
import { app } from "../src/index.js";

let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

const DAY = 86_400_000;
const now = Date.UTC(2026, 6, 22, 12, 0, 0); // sabit "simdi" — deterministik

// lastActivityMs — en yeni hareket kazanir; hicbiri yoksa createdate; o da yoksa null
check("son hareket: notes yenisi kazanir", lastActivityMs({
  notes_last_updated: new Date(now - 2 * DAY).toISOString(),
  ff_last_meeting_date: new Date(now - 9 * DAY).toISOString(),
}) === now - 2 * DAY);
check("son hareket: ff yenisi kazanir", lastActivityMs({
  notes_last_updated: new Date(now - 9 * DAY).toISOString(),
  ff_last_meeting_date: new Date(now - 3 * DAY).toISOString(),
}) === now - 3 * DAY);
check("son hareket: yalniz createdate", lastActivityMs({
  createdate: new Date(now - 5 * DAY).toISOString(),
}) === now - 5 * DAY);
check("son hareket: hicbiri yok -> null", lastActivityMs({}) === null);
check("son hareket: bozuk tarih -> null", lastActivityMs({ notes_last_updated: "not-a-date" }) === null);

// isStale — 7 gun esigi (>=)
const fresh3 = { notes_last_updated: new Date(now - 3 * DAY).toISOString() };
const stale9 = { notes_last_updated: new Date(now - 9 * DAY).toISOString() };
const exactly7 = { notes_last_updated: new Date(now - 7 * DAY).toISOString() };
check("bayat: 3 gun -> hayir", isStale(fresh3, 7, now) === false);
check("bayat: 9 gun -> evet", isStale(stale9, 7, now) === true);
check("bayat: tam 7 gun -> evet", isStale(exactly7, 7, now) === true);
check("bayat: tarih bilinmiyor -> dokunma", isStale({}, 7, now) === false);

// SWEEP_TARGETS — iki pipeline da Meeting -> Follow-Up
check("hedef: Sales Meeting -> Follow-Up",
  SWEEP_TARGETS.some((t) => t.from === STAGE.meeting && t.to === STAGE.followUp));
check("hedef: VC Meeting -> Follow-up",
  SWEEP_TARGETS.some((t) => t.from === VC_STAGE.meeting && t.to === VC_STAGE.followUp));
check("hedef: yalniz 2 pipeline", SWEEP_TARGETS.length === 2);

// Endpoint auth (Hono app.request — network yok)
const hint = await app.request("/api/stage-sweep");
const hintJson: any = await hint.json();
check("GET anahtarsiz -> 200 hint", hint.status === 200 && hintJson.hint !== undefined);
const bad = await app.request("/api/stage-sweep?key=WRONG");
check("yanlis key -> 401", bad.status === 401);
const noEnv = await app.request("/api/stage-sweep?key=test-secret&dry=1");
const noEnvJson: any = await noEnv.json();
check("dogru key, token'siz -> 200 + acik hata",
  noEnv.status === 200 && noEnvJson.ok === false && /HUBSPOT_TOKEN/.test(noEnvJson.error || ""));

console.log(fail === 0 ? "\nOK: supurucu duman testi gecti" : `\nHATA: ${fail} kontrol basarisiz`);
process.exit(fail === 0 ? 0 : 1);
