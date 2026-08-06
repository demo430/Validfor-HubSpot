import { buildExtractPrompt } from "../lib/classify.js";
import type { Transcript } from "../lib/fireflies.js";

// Faz 4 duman testi: network'e cikmadan, prompt olusturucunun transkript
// icerigini dogru serialize ettigini dogrular.
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

const t: Transcript = {
  id: "TEST",
  title: "Meet – Amplelogics x Validfor Intro & Demo",
  dateString: "2026-07-13T16:00:00.000Z",
  duration: 45,
  meeting_attendees: [
    { displayName: "Rahul S", email: "rahul.s@amplelogic.com" },
    { displayName: "Demo", email: "demo@validfor.com" },
  ],
  speakers: [{ name: "Rahul S" }],
  sentences: [
    { speaker_name: "Rahul S", text: "We should explore a partnership.", start_time: 0 },
  ],
  summary: { overview: "Partnership strategy discussion." },
};

const prompt = buildExtractPrompt(t);
check("prompt basligi iceriyor", prompt.includes("Amplelogics x Validfor"));
check("prompt Validfor-internal notunu iceriyor", /Validfor.*internal/is.test(prompt));
check("prompt katilimcilari iceriyor", prompt.includes("rahul.s@amplelogic.com"));
check("prompt overview'i iceriyor", prompt.includes("Partnership strategy"));
check("prompt transkripti iceriyor", prompt.includes("explore a partnership"));

console.log(
  fail === 0
    ? "\nOK: Faz 4 classify duman testi gecti"
    : `\nHATA: ${fail} kontrol basarisiz`,
);
process.exit(fail === 0 ? 0 : 1);
