import { loadEnv } from "../lib/env.js";
import * as hs from "../lib/hubspot.js";

// HubSpot'ta minimal ff_* ozel alanlarini (deal + contact) olusturur.
// Calistir: npm run setup-properties
// Gerekli yetki: crm.schemas.deals.write + crm.schemas.contacts.write
// Tekrar calistirmak guvenli: var olan alanlari gunceller, atlar.

loadEnv();

const GROUP_NAME = "ff_meeting_intel";
const GROUP_LABEL = "Meeting Intel (Fireflies)";

type PropDef = {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  options?: Array<{ label: string; value: string; displayOrder: number }>;
};

// Minimal alan seti. Yeni alan gerekince buraya ekle — script idempotent,
// tekrar calistirinca var olani gunceller. (Faz 5'te Routine'in yazacagi
// alanlara gore genisletiriz.)
const DEAL_PROPS: PropDef[] = [
  { name: "ff_last_meeting_date", label: "Last Meeting Date", type: "date", fieldType: "date" },
  { name: "ff_last_meeting_summary", label: "Last Meeting Summary", type: "string", fieldType: "textarea" },
  { name: "ff_fireflies_link", label: "Fireflies Link", type: "string", fieldType: "text" },
  // Islenmis transkript ULID'leri (";" ayracli) — guclu tutarli idempotency isareti.
  { name: "ff_processed_transcripts", label: "Processed Transcripts (Fireflies)", type: "string", fieldType: "textarea" },
];

const CONTACT_PROPS: PropDef[] = [
  { name: "ff_last_meeting_date", label: "Last Meeting Date", type: "date", fieldType: "date" },
  { name: "ff_last_meeting_summary", label: "Last Meeting Summary", type: "string", fieldType: "textarea" },
  { name: "ff_fireflies_link", label: "Fireflies Link", type: "string", fieldType: "text" },
  // Outreach girisi (Apollo senkronu). LinkedIn icin standart hs_linkedin_url
  // kullanilir (yazilabilir oldugu dogrulandi) — custom property gerekmez.
  { name: "outreach_source", label: "Outreach Source", type: "string", fieldType: "text" },
  { name: "apollo_list", label: "Apollo List", type: "string", fieldType: "text" },
  // Apollo kisi-zenginlestirme damgasi: contact Apollo'ya EN FAZLA BIR KEZ
  // sorulur (kredi korumasi). Degerler: ISO tarih | complete | notfound ... | skipped
  { name: "apollo_enriched_at", label: "Apollo Enriched At", type: "string", fieldType: "text" },
];

// Sirket tarafinda tek alan: Apollo sorgu damgasi (kredi korumasi). Sirket
// basina EN FAZLA BIR Apollo sorgusu — damgali sirket bir daha sorulmaz.
const COMPANY_PROPS: PropDef[] = [
  { name: "apollo_enriched_at", label: "Apollo Enriched At", type: "string", fieldType: "text" },
];

async function ensureGroup(objectType: string): Promise<boolean> {
  try {
    const r = await hs.ensurePropertyGroup(objectType, GROUP_NAME, GROUP_LABEL);
    console.log(`[group] ${objectType}/${GROUP_NAME}: ${r}`);
    return true;
  } catch (e: any) {
    console.error(
      `[group] ${objectType}/${GROUP_NAME}: HATA ${e.status || ""} ${String(e.message).slice(0, 140)}`,
    );
    if (e.status === 403 || /MISSING_SCOPES/i.test(e.message)) {
      console.error(
        `>>> '${objectType}' icin schema-write izni yok; bu obje ATLANIYOR (crm.schemas.${objectType}.write gerekli).`,
      );
      return false;
    }
    throw e;
  }
}

async function ensureProps(objectType: string, props: PropDef[]): Promise<void> {
  for (const p of props) {
    const def = { groupName: GROUP_NAME, ...p };
    try {
      const r = await hs.createProperty(objectType, def);
      if (r === "exists") {
        // Var olan property: label + secenekleri tazele (HubSpot tip degisikligine
        // izin vermez, sadece label/options).
        const patch: Record<string, unknown> = { label: p.label };
        if (p.options) patch.options = p.options;
        await hs.updateProperty(objectType, p.name, patch);
        console.log(`[prop ] ${objectType}.${p.name}: updated`);
      } else {
        console.log(`[prop ] ${objectType}.${p.name}: ${r}`);
      }
    } catch (e: any) {
      console.error(`[prop ] ${objectType}.${p.name}: HATA ${e.status || ""} ${e.message}`);
      if (e.status === 403 || /MISSING_SCOPES/i.test(e.message)) {
        console.error(
          `\n>>> '${objectType}' icin yetki eksik. Private App -> Scopes: ` +
            `crm.schemas.${objectType}.write ekleyip kaydet, sonra tekrar calistir. Bu obje atlaniyor.\n`,
        );
        return;
      }
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.HUBSPOT_TOKEN) {
    console.error("HUBSPOT_TOKEN yok. .env.local doldur veya ortam degiskeni ver.");
    process.exit(1);
  }
  try {
    const me = await hs.whoAmI();
    console.log(`HubSpot portal: ${me.portalId || me.hub_id || "(bilinmiyor)"}`);
  } catch (e: any) {
    console.error("Token dogrulanamadi:", e.message);
    process.exit(1);
  }

  if (await ensureGroup("deals")) await ensureProps("deals", DEAL_PROPS);
  if (await ensureGroup("contacts")) await ensureProps("contacts", CONTACT_PROPS);
  if (await ensureGroup("companies")) await ensureProps("companies", COMPANY_PROPS);

  console.log(
    '\nBitti. Ozel alanlar deal ve contact uzerinde hazir (grup: "Meeting Intel (Fireflies)").',
  );
}

main();
