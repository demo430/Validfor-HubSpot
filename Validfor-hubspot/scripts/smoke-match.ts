import {
  extractEmails,
  tokenize,
  domainRoot,
  cardFacts,
  transcriptFacts,
  scoreMatch,
  confidenceOf,
  matchCards,
} from "../lib/match.js";
import type { TrelloCard } from "../lib/trello.js";

// Faz 8 duman testi: eslestirme saf mantigini network'suz dogrular.
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

// extractEmails
check(
  "email cikarma",
  JSON.stringify(extractEmails("Iletisim: Jane.Doe@Acme.com ve x@y.io")) ===
    JSON.stringify(["jane.doe@acme.com", "x@y.io"]),
);
check("email yok -> bos", extractEmails("merhaba dunya").length === 0);

// tokenize — stopword + kisa token filtresi
check(
  "tokenize stopword atar",
  JSON.stringify(tokenize("Amplelogic x Validfor Intro & Demo")) ===
    JSON.stringify(["amplelogic"]),
);

// domainRoot
check("domainRoot", domainRoot("amplelogic.com") === "amplelogic");
check("domainRoot subdomain", domainRoot("mail.acme.co") === "acme");

const mkCard = (over: Partial<TrelloCard>): TrelloCard => ({
  id: "c1",
  name: "",
  desc: "",
  due: null,
  dateLastActivity: null,
  idList: "l1",
  listName: "Demo Yapildi",
  labels: [],
  memberNames: [],
  customTexts: [],
  url: "",
  ...over,
});

// E-posta kesisimi -> yuksek guven
const cardEmail = mkCard({
  name: "Acme demo",
  desc: "Katilimci: jane@acme.com",
  due: "2026-07-09T10:00:00.000Z",
});
const tAcme = {
  id: "T1",
  title: "Acme x Validfor Demo",
  dateString: "2026-07-09T10:00:00.000Z",
  meeting_attendees: [
    { email: "jane@acme.com", displayName: "Jane Doe" },
    { email: "demo@validfor.com" },
  ],
};
const tOther = {
  id: "T2",
  title: "Globex Intro",
  dateString: "2026-06-01T10:00:00.000Z",
  meeting_attendees: [{ email: "bob@globex.com", displayName: "Bob" }],
};
const [mEmail] = matchCards([cardEmail], [tAcme, tOther]);
check("email eslesme -> T1", mEmail.best?.t.id === "T1");
check("email eslesme -> high", mEmail.confidence === "high");
check("email eslesme -> belirsiz degil", mEmail.ambiguous === false);

// Sadece isim/domain benzerligi -> orta seviye
const cardName = mkCard({ name: "Globex goruşmesi", due: "2026-06-02T09:00:00.000Z" });
const [mName] = matchCards([cardName], [tAcme, tOther]);
check("isim eslesme -> T2", mName.best?.t.id === "T2");
check(
  "isim eslesme guveni medium/high",
  mName.confidence === "medium" || mName.confidence === "high",
);

// Hic sinyal yok -> eslesme yok
const cardNone = mkCard({ name: "Tamamen alakasiz seyler" });
const [mNone] = matchCards([cardNone], [tAcme, tOther]);
check("sinyalsiz -> none", mNone.confidence === "none" && mNone.best === null);

// Ic e-postalar transcriptFacts'te elenir
const tf = transcriptFacts(tAcme as any);
check("internal email elenir", !tf.attendeeEmails.includes("demo@validfor.com"));
check("harici domain koku", JSON.stringify(tf.externalDomainRoots) === JSON.stringify(["acme"]));

// confidenceOf esikleri
check("conf: email hit -> high", confidenceOf(10, true) === "high");
check("conf: 80 -> high", confidenceOf(80, false) === "high");
check("conf: 50 -> medium", confidenceOf(50, false) === "medium");
check("conf: 30 -> low", confidenceOf(30, false) === "low");
check("conf: 10 -> none", confidenceOf(10, false) === "none");

// scoreMatch tarih sinyali
const cf = cardFacts(cardEmail);
const sm = scoreMatch(cf, tf);
check("skor >= 100 (email)", sm.score >= 100);
check("tarih yakin sebep var", sm.reasons.some((r) => r.startsWith("tarih")));

console.log(fail === 0 ? "\nOK: Faz 8 eslestirme duman testi gecti" : `\nHATA: ${fail} kontrol basarisiz`);
process.exit(fail === 0 ? 0 : 1);
