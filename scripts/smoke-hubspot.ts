import { apiBase, plural, hsFetch } from "../lib/hubspot.js";

// Faz 1 duman testi: HubSpot client'in network'e cikmadan dogru davrandigini
// dogrular (apiBase cozumu, plural haritasi, token yoksa anlamli hata).
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

async function main(): Promise<void> {
  // apiBase varsayilan + EU override + trailing-slash trim
  delete process.env.HUBSPOT_API_BASE;
  check("apiBase varsayilan = api.hubapi.com", apiBase() === "https://api.hubapi.com");
  process.env.HUBSPOT_API_BASE = "https://api-eu1.hubapi.com/";
  check("apiBase EU + slash trim", apiBase() === "https://api-eu1.hubapi.com");
  delete process.env.HUBSPOT_API_BASE;

  // plural haritasi
  check("plural deal -> deals", plural("deal") === "deals");
  check("plural companies -> companies", plural("companies") === "companies");
  check("plural bilinmeyen -> aynen", plural("tickets") === "tickets");

  // token yoksa hsFetch network'e CIKMADAN anlamli hata verir (token() once cagrilir)
  const saved = process.env.HUBSPOT_TOKEN;
  delete process.env.HUBSPOT_TOKEN;
  let threw = "";
  try {
    await hsFetch("/crm/v3/objects/deals/1");
  } catch (e: any) {
    threw = e.message || "";
  }
  check("token yoksa hsFetch firlatir", /HUBSPOT_TOKEN/.test(threw));
  if (saved) process.env.HUBSPOT_TOKEN = saved;

  console.log(
    fail === 0
      ? "\nOK: Faz 1 hubspot duman testi gecti"
      : `\nHATA: ${fail} kontrol basarisiz`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main();
