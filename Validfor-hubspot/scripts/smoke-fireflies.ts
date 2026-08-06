import { fetchTranscript, viewUrl, extractTranscriptId } from "../lib/fireflies.js";

// Faz 2 duman testi: network'e cikmadan client guard'larini dogrular.
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

async function main(): Promise<void> {
  // viewUrl formati
  check(
    "viewUrl dogru format",
    viewUrl("abc123") === "https://app.fireflies.ai/view/abc123",
  );

  // extractTranscriptId — cesitli girdi formlari
  check("extract: bare ULID", extractTranscriptId("01KX354T93DF90PKFXQ33XV0C6") === "01KX354T93DF90PKFXQ33XV0C6");
  check("extract: slug::ULID", extractTranscriptId("Meet-Demo::01KX354T93DF90PKFXQ33XV0C6") === "01KX354T93DF90PKFXQ33XV0C6");
  check("extract: slug::ULID?query", extractTranscriptId("Meet-Demo::01KX354T93DF90PKFXQ33XV0C6?channelSource=all") === "01KX354T93DF90PKFXQ33XV0C6");
  check("extract: full view URL", extractTranscriptId("https://app.fireflies.ai/view/Meet-Demo::01KX354T93DF90PKFXQ33XV0C6?x=1") === "01KX354T93DF90PKFXQ33XV0C6");
  check("extract: bos -> bos", extractTranscriptId("") === "");

  // API key yoksa anlamli hata (network'e cikmadan)
  const saved = process.env.FIREFLIES_API_KEY;
  delete process.env.FIREFLIES_API_KEY;
  let threw = "";
  try {
    await fetchTranscript("some-id");
  } catch (e: any) {
    threw = e.message || "";
  }
  check("key yoksa fetchTranscript firlatir", /FIREFLIES_API_KEY/.test(threw));

  // transcriptId bos ise (key varken) anlamli hata
  process.env.FIREFLIES_API_KEY = "dummy-key-for-guard-test";
  let threw2 = "";
  try {
    await fetchTranscript("");
  } catch (e: any) {
    threw2 = e.message || "";
  }
  check("bos transcriptId firlatir", /transcriptId bos/.test(threw2));
  if (saved) process.env.FIREFLIES_API_KEY = saved;
  else delete process.env.FIREFLIES_API_KEY;

  console.log(
    fail === 0
      ? "\nOK: Faz 2 fireflies duman testi gecti"
      : `\nHATA: ${fail} kontrol basarisiz`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main();
