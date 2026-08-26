import {
  normPersonName,
  resolveOwnerId,
  clearOwnersCache,
  envOwnerMapSize,
} from "../lib/hubspot.js";
import { backfillDealOwners } from "../lib/owners.js";
import { app } from "../src/index.js";

// Owner atama duman testi: ad normalizasyonu, ad -> ownerId cozumlemesi ve
// /api/backfill-owners rotasinin auth davranisi. Network'e CIKMAZ (fetch
// sahtelenir).
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) fail++;
}

const OWNERS = [
  { id: "11", email: "omer.cimen@validfor.com", firstName: "Ömer", lastName: "Çimen" },
  { id: "22", email: "bharani@validfor.com", firstName: "Bharani", lastName: "K" },
  { id: "33", email: "burak@validfor.com", firstName: "Burak", lastName: "Yilmaz" },
  { id: "44", email: "burak.d@validfor.com", firstName: "Burak", lastName: "Demir" },
  { id: "99", email: "eski@validfor.com", firstName: "Eski", lastName: "Uye", archived: true },
];

// --- fetch sahtelemesi: HubSpot cagrilarini bellekten yanitlar ---
const calls: Array<{ url: string; body: any }> = [];
let ownersApiDown = false;
let dealPages: any[][] = [];
function installFetch(): void {
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const json = (data: any) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/crm/v3/owners")) {
      if (ownersApiDown) {
        return new Response(JSON.stringify({ category: "MISSING_SCOPES" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return json({ results: OWNERS });
    }
    if (url.includes("/crm/v3/objects/deals/search")) {
      const page = dealPages.shift() || [];
      return json({ results: page });
    }
    if (url.includes("/batch/update")) return json({ results: [] });
    return json({});
  };
}

async function main(): Promise<void> {
  process.env.HUBSPOT_TOKEN = "test-token";
  process.env.FIREFLIES_WEBHOOK_SECRET = "s3cret";

  // --- normPersonName ---
  check("normPersonName aksan katlar", normPersonName("Ömer Çimen") === "omer cimen");
  check("normPersonName noktalama", normPersonName(" Burak  Yılmaz. ") === "burak yilmaz");
  check("normPersonName bos", normPersonName("") === "");
  check(
    "normPersonName farkli kisiler karismaz",
    normPersonName("Burak Yilmaz") !== normPersonName("Burak Demir"),
  );

  installFetch();

  // --- resolveOwnerId ---
  clearOwnersCache();
  check(
    "e-posta ile eslesme",
    (await resolveOwnerId({ email: "BHARANI@validfor.com" })) === "22",
  );
  check(
    "aksanli tam ad ile eslesme",
    (await resolveOwnerId({ name: "Omer Cimen" })) === "11",
  );
  check(
    "tek ad + tek aday -> eslesir",
    (await resolveOwnerId({ name: "Bharani" })) === "22",
  );
  check(
    "tek ad + iki aday -> belirsiz, bos doner",
    (await resolveOwnerId({ name: "Burak" })) === "",
  );
  check(
    "bilinmeyen ad -> bos doner",
    (await resolveOwnerId({ name: "Kimse Yok" })) === "",
  );
  check("bos girdi -> bos doner", (await resolveOwnerId({})) === "");

  // --- VALIDFOR_OWNER_MAP yedek yolu ---
  // Owners API'si 403 verse bile (private app'te crm.objects.owners.read yoksa)
  // atama calismali; API calisiyorsa env haritasi ONE GECMEMELI.
  delete process.env.VALIDFOR_OWNER_MAP;
  check("env haritasi tanimsizken bos", envOwnerMapSize() === 0);

  process.env.VALIDFOR_OWNER_MAP =
    "omer.cimen@validfor.com:11, Ömer Çimen :11,Bharani:22,Burak:33,bozuk-satir,Kotu:abc";
  check("env haritasi ayrisir (bozuk satirlar atlanir)", envOwnerMapSize() === 4);
  check(
    "rakam olmayan ownerId reddedilir",
    (await resolveOwnerId({ name: "Kotu" })) === "",
  );

  // API AYAKTA: env haritasi devreye girmemeli — portal gercegi kazanir.
  ownersApiDown = false;
  clearOwnersCache();
  process.env.VALIDFOR_OWNER_MAP = "Burak:33"; // API'de "Burak" belirsiz (iki kisi)
  check(
    "API ayaktayken belirsiz ad env'den cozulur (son care)",
    (await resolveOwnerId({ name: "Burak" })) === "33",
  );
  process.env.VALIDFOR_OWNER_MAP = "bharani@validfor.com:999";
  clearOwnersCache();
  check(
    "API ayaktayken API kazanir (env EZMEZ)",
    (await resolveOwnerId({ email: "bharani@validfor.com" })) === "22",
  );

  // API 403: yalniz env haritasi kalir.
  ownersApiDown = true;
  clearOwnersCache();
  process.env.VALIDFOR_OWNER_MAP =
    "omer.cimen@validfor.com:11,Bharani Rajendran:22,Bharani:22";
  check(
    "API 403 iken e-posta env'den cozulur",
    (await resolveOwnerId({ email: "OMER.CIMEN@validfor.com" })) === "11",
  );
  check(
    "API 403 iken aksanli ad env'den cozulur",
    (await resolveOwnerId({ name: "Bharani Rajendran" })) === "22",
  );
  check(
    "API 403 + haritada yoksa bos doner",
    (await resolveOwnerId({ name: "Kimse Yok" })) === "",
  );

  // API 403 + env haritasi VARSA backfill kosmaya devam eder.
  dealPages = [[
    { id: "9", properties: { dealname: "Env Kart", deal_owner_validfor: "Bharani" } },
  ]];
  calls.length = 0;
  const envRun = await backfillDealOwners({ dry: false });
  const envWrites = calls.filter((c) => c.url.includes("batch/update"));
  check("API 403 + env: kart yine de atanir", envRun.assigned === 1);
  check(
    "API 403 + env: dogru ownerId yazilir",
    envWrites[0]?.body?.inputs?.[0]?.properties?.hubspot_owner_id === "22",
  );

  // API 403 + env haritasi YOKSA hicbir kart taranmaz (bosuna istek atilmaz).
  delete process.env.VALIDFOR_OWNER_MAP;
  clearOwnersCache();
  dealPages = [[
    { id: "9", properties: { dealname: "Env Kart", deal_owner_validfor: "Bharani" } },
  ]];
  calls.length = 0;
  const noEnvRun = await backfillDealOwners({ dry: false });
  check("API 403 + env yok: taranmaz", noEnvRun.scanned === 0 && noEnvRun.errors === 1);
  check(
    "API 403 + env yok: deal aramasi bile yapilmaz",
    !calls.some((c) => c.url.includes("deals/search")),
  );

  // Testin geri kalani API AYAKTA + env YOK varsayimiyla kosar.
  ownersApiDown = false;
  clearOwnersCache();

  // --- backfillDealOwners: dry hicbir sey yazmaz ---
  const deals = [
    { id: "1", properties: { dealname: "Julphar", deal_owner_validfor: "Ömer Çimen" } },
    { id: "2", properties: { dealname: "CHG", deal_owner_validfor: "Bharani" } },
    { id: "3", properties: { dealname: "LuceNox", deal_owner_validfor: "Burak" } },
    { id: "4", properties: { dealname: "Bossuz", deal_owner_validfor: "" } },
  ];
  dealPages = [deals];
  calls.length = 0;
  const dryRun = await backfillDealOwners({ dry: true });
  check("dry: 4 kart tarandi", dryRun.scanned === 4);
  check("dry: 2 kart atanabilir", dryRun.assigned === 2);
  check("dry: belirsiz ad raporlanir", dryRun.unresolved["Burak"] === 1);
  check("dry: bos ad unresolved'a girmez", !("" in dryRun.unresolved));
  check("dry: HIC yazma yok", !calls.some((c) => c.url.includes("batch/update")));
  check("dry: done", dryRun.done === true);

  // Arama filtresi: sahipsiz + Deal Owner Validfor dolu kartlar
  const search = calls.find((c) => c.url.includes("deals/search"));
  const filters = search?.body?.filterGroups?.[0]?.filters || [];
  check(
    "arama: hubspot_owner_id BOS olanlar",
    filters.some(
      (f: any) => f.propertyName === "hubspot_owner_id" && f.operator === "NOT_HAS_PROPERTY",
    ),
  );
  check(
    "arama: deal_owner_validfor DOLU olanlar",
    filters.some(
      (f: any) => f.propertyName === "deal_owner_validfor" && f.operator === "HAS_PROPERTY",
    ),
  );

  // --- gercek kosum: yalniz cozulen kartlar yazilir ---
  dealPages = [deals];
  calls.length = 0;
  const wet = await backfillDealOwners({ dry: false });
  const writes = calls.filter((c) => c.url.includes("batch/update"));
  check("yazma: tek toplu istek", writes.length === 1);
  const inputs = writes[0]?.body?.inputs || [];
  check("yazma: 2 kart", inputs.length === 2);
  check(
    "yazma: Julphar -> Omer (11)",
    inputs.find((i: any) => i.id === "1")?.properties?.hubspot_owner_id === "11",
  );
  check(
    "yazma: CHG -> Bharani (22)",
    inputs.find((i: any) => i.id === "2")?.properties?.hubspot_owner_id === "22",
  );
  check(
    "yazma: belirsiz kart yazilmaz",
    !inputs.some((i: any) => i.id === "3"),
  );
  check("yazma: assigned=2", wet.assigned === 2);

  // --- route: anahtarsiz GET aciklama doner, yanlis anahtar 401 ---
  const info = await app.fetch(new Request("http://localhost/api/backfill-owners"));
  check("GET anahtarsiz -> 200 aciklama", info.status === 200);
  check("GET aciklama route adi", (await info.text()).includes("backfill-owners"));

  const bad = await app.fetch(
    new Request("http://localhost/api/backfill-owners?dry=1", {
      headers: { "x-webhook-secret": "yanlis" },
    }),
  );
  check("GET yanlis anahtar -> 401", bad.status === 401);

  const gate = await app.fetch(
    new Request("http://localhost/api/backfill-owners", {
      headers: { "x-webhook-secret": "s3cret" },
    }),
  );
  const gateBody = await gate.text();
  check("GET anahtarli ama dry'siz -> yazmaz", gateBody.includes("POST kullanin"));

  if (fail) {
    console.error(`HATA: ${fail} kontrol basarisiz`);
    process.exit(1);
  }
  console.log("OK: owner atama duman testi gecti");
}

main();
