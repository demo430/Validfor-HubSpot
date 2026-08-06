import { app } from "../src/index.js";

// Faz 0 duman testi: uygulamayi gercek bir port'a baglamadan, Hono'nun
// fetch handler'ini dogrudan cagirarak route'larin 200 dondugunu dogrular.
async function main() {
  const root = await app.fetch(new Request("http://localhost/"));
  console.log("GET /             ->", root.status, await root.text());

  const ff = await app.fetch(new Request("http://localhost/api/fireflies"));
  console.log("GET /api/fireflies ->", ff.status, await ff.text());

  if (root.status !== 200 || ff.status !== 200) {
    console.error("HATA: beklenen 200 alinamadi");
    process.exit(1);
  }
  console.log("OK: Faz 0 duman testi gecti");
}

main();
