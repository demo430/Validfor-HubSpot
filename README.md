# Validfor Relay — Toplantı → CRM Otomasyonu (sade sürüm)

**Tek cümle:** Bir toplantı Fireflies'ta kaydedilince, otomatik olarak Claude
(Sonnet 5) ile sınıflandırılıp HubSpot'a temiz bir kayıt (özet not + dolu alanlar
+ transkript PDF) düşer. Elle veri girişi yok.

> DOMiNO'nun sadeleştirilmiş türevi: Fireflies → Claude API → HubSpot + transkript
> PDF. Notion, Trello canlı senkron, dashboard, durable workflow ve (async gerektiren)
> Claude Routine katmanları çıkarıldı — her şey tek webhook'ta **senkron** çalışır.

## Akış (hedef mimari)

```
Fireflies (kayıt + özet)
  → webhook  POST /api/fireflies
       1. Fireflies'tan transkripti çek
       2. Claude (Sonnet 5) ile sınıflandır + alan çıkar  → yapısal JSON
       3. HubSpot: şirket / contact / deal bul-oluştur + özet not + ff_* alanlar
       4. Transkript PDF üret + nota ekle
       → 200  (hepsi senkron, birkaç saniye)
  → script  backfill: Trello kartları → Fireflies → aynı pipeline (geriye dönük)
  → cron    /api/apollo-sync: Apollo listeleri → HubSpot lead girişi (günlük 07:00 UTC)
  → cron    /api/stage-sweep: "Meeting"de 7 gündür hareketsiz deal'lar → Follow-Up (günlük 07:30 UTC)
            ├ aynı koşumda calendar-sync: Google Takvim'deki VC toplantıları → VC Pipeline'da
            │ deal (Calendly kaynaklılar hariç — onlar demo). Gelecek toplantı → giriş stage'i;
            │ son 7 günde kaçırılmış geçmiş toplantı → doğrudan "Meeting" (?past=90 ile genişler)
            ├ aynı koşumda calendar-demos: Google Takvim'deki demolar → Sales Pipeline'da
            │ deal ("Unassigned"). Calendly API'sinden BAGIMSIZ yol — rezervasyonlar
            │ organizatörün takvimine düştüğü için token bozuk olsa da demolar yakalanır
            └ aynı koşumda calendly-sync: Calendly'deki planlanmış demolar →
              Sales Pipeline'da deal ("Scheduled"; demo gerçekleşince Meeting'e geçer).
              Yalnız `CALENDLY_TOKEN` tanımlıysa koşar; token bozuksa sonuç boş döner
```

**Pipeline yönlendirme:** normal toplantılar Sales Pipeline'a düşer (toplantı
gerçekleşince AUTO "Meeting", ikinci toplantıda AUTO "Follow-Up"; Contract/PoC/
Won/Lost tamamen manuel). Yatırımcı toplantıları (`meetingType=investor`) ayrı
**VC Pipeline**'a düşer ve aynı ayna kuralla ilerler: Contacted elle → toplantı
gerçekleşince AUTO "Meeting" → ikinci toplantıda AUTO "Follow-up"; Due Diligence,
Term Sheet Received, Closed Won/Lost ve Not Priority tamamen manuel. Ayrıca
günlük süpürücü (`/api/stage-sweep`): iki pipeline'da da "Meeting"de **7 gündür
hareket görmeyen** deal'lar otomatik Follow-Up'a taşınır (hareket = son loglanan
not/e-posta/arama/toplantı ya da son Fireflies toplantısı; manuel bölgeye asla
dokunulmaz).

**Kart alanları:** boş-alan kuralıyla otomatik dolar (insanın girdiği değer asla
ezilmez). Bilinçli **manuel** bırakılanlar — Sales kartının son 3 alanı
(Likelihood / Demo Status / Validfor Priority) ve VC kartının son alanı
(Likelihood). VC kartının diğer alanları (Investment Vertical(s)/Stage/Region,
Min/Max Ticket Size, Investment Type) yatırımcı toplantısından otomatik dolar;
iç adlar HubSpot'tan etikete göre canlı çözülür (`lib/vcfields.ts`).

## Teknoloji

Hono · TypeScript · Vercel (deploy) · **Claude API (`claude-sonnet-5`)** ·
Fireflies + HubSpot REST · pdfkit (transkript PDF).

> Neon Postgres / durable workflow / cron **yok** — idempotency, HubSpot'taki
> `fireflies_link` ile sağlanır (aynı toplantı iki kez gelse kopya oluşmaz).

## Geliştirme

```bash
npm install
npm run smoke        # Faz 0 duman testi (port bağlamadan route kontrolü)
npm run dev          # yerel sunucu -> http://localhost:3000
npm run typecheck    # tsc --noEmit

npm run backfill-companies -- --dry   # mevcut şirketleri Apollo ile doldur (önizleme)
npm run backfill-companies            # gerçek yazım (yalnız boş alanlar dolar)
```

> **Deal owner atama:** `/api/backfill-owners?key=SECRET&dry=1` önizler, POST
> yazar. Karttaki "Deal Owner Validfor" adını HubSpot kullanıcısına çevirip
> standart `Deal owner` alanına yazar; dolu owner'a dokunmaz, ad tekil
> çözülemezse kartı atlar ve `unresolved` altında raporlar.

> Lokal kurulum gerekmeden aynı iş deploy üzerinden de yapılır (tarayıcıdan):
> `/api/backfill-companies?key=SECRET&dry=1` ile önizle, sonra `dry`'sız çağır.
> Her çağrı en fazla 40 şirketi Apollo'ya sorar (60s bütçesi); yanıtta
> `done:false` gördükçe aynı URL'yi tekrar çağır — `filled:0` + `done:true` = bitti.

> **Bulut session notu:** Anthropic bulut ortamında (egress proxy arkasında)
> Node'un built-in `fetch`'i `HTTPS_PROXY`'yi otomatik okumaz. Dış servise
> (HubSpot/Fireflies) çıkan komutları `NODE_USE_ENV_PROXY=1` ile çalıştır:
> `NODE_USE_ENV_PROXY=1 npm run setup-properties`. Vercel'de ve yerel makinede
> gerekmez (zararsızdır). *(Anthropic API'si `anthropic.com` proxy'yi baypas
> ettiği için doğrudan çalışır.)*

## Yol haritası (fazlar)

| Faz | İçerik | Durum |
|-----|--------|-------|
| 0 | Repo iskeleti + health route'ları | ✅ |
| 1 | HubSpot client + `setup-properties` (özel alanlar) | ✅ canlı (portal 148916475, EU) |
| 2 | Fireflies transkript çekme | ✅ canlı |
| 3 | Transkript PDF üretimi (Türkçe font gömülü) | ✅ canlı (30 sayfa) |
| 4 | Claude sınıflandırma (Sonnet 5 → yapısal JSON) | ✅ canlı (~3 sent/toplantı, ~7 sn) |
| 5 | Upsert (company/contact/deal + not + PDF ekle) | ✅ canlı doğrulandı (Amplelogic kaydı + PDF, idempotent) |
| 6 | `POST /api/fireflies` webhook (senkron pipeline) | ✅ canlı doğrulandı (uçtan uca 200) |
| 7 | Vercel deploy + gerçek Fireflies webhook | ✅ canlı (production; `GET /` sürüm + deploy commit'ini döner) |
| 8 | Backfill script (Trello kartları → Fireflies → HubSpot) | ✅ (`match-trello` eşleştirme raporu + `backfill-trello`) |
| 9 | Apollo → HubSpot outreach senkronu (`/api/apollo-sync` + Vercel cron) | ✅ canlı |
| 10 | Pipeline yeniden yapılanması + VC Pipeline yönlendirme + kart otomasyonu | ✅ canlı (manuel alanlar yukarıda) |

## Ortam değişkenleri

Değerler repoda **tutulmaz** (`.env.local`, Vercel env).

| Değişken | Ne için |
|---|---|
| `FIREFLIES_API_KEY` | Transkript çekme |
| `FIREFLIES_WEBHOOK_SECRET` | Webhook auth (deny-by-default) |
| `HUBSPOT_TOKEN` | HubSpot Private App token (Bearer) |
| `HUBSPOT_API_BASE` | EU portal için `https://api-eu1.hubapi.com` |
| `ANTHROPIC_API_KEY` | Claude API (beyin) |
| `APOLLO_API_KEY` · `APOLLO_LIST_NAMES` | Apollo outreach senkronu (liste adları virgüllü) + şirket zenginleştirme (`organizations/enrich`; key yoksa adım atlanır) |
| `CRON_SECRET` | Vercel cron auth (`FIREFLIES_WEBHOOK_SECRET` ile aynı değer yeterli) |
| `GOOGLE_SA_EMAIL` · `GOOGLE_SA_PRIVATE_KEY` · `GOOGLE_CALENDAR_ID` | Takvim senkronu (**önerilen yol**: service account — takvim özel kalır). Her takvimi service account e-postasıyla "Tüm etkinlik ayrıntılarını görme" izniyle paylaş; Calendar ID takvim ayarlarındaki "Takvimi entegre et" bölümünde. **Birden çok takvim virgülle**: `a@x.com,b@group.calendar.google.com`. Env yoksa adım atlanır |
| `GOOGLE_CALENDAR_API_KEY` | Takvim senkronu alternatifi: API key **yalnız herkese açık takvim** okur (service account env'leri yoksa kullanılır) |
| `CALENDLY_TOKEN` | Calendly PAT (`scheduled_events:read` yeterli) — planlanmış demolar Sales "Scheduled"a düşer. Env yoksa adım atlanır. **Mevcut token 403 "Insufficient scope" veriyor**; demolar bunun yerine `calendar-demos` ile takvimden yakalanıyor |
| `VALIDFOR_OWNER_MAP` | Deal owner **yedek** eşlemesi: virgüllü `anahtar:ownerId` çiftleri (anahtar e-posta ya da ad). Yalnız `/crm/v3/owners` erişilemezse (private app'te `crm.objects.owners.read` yoksa) kullanılır; API çalışıyorsa önce o. Env yoksa adım atlanır |
| `VALIDFOR_INTERNAL_DOMAINS` | İç katılımcı sayılan domain'ler (virgüllü) — varsayılan `validfor.com` |
| `VC_EXCLUDE_DOMAINS` | Takvim senkronunun **asla** VC deal'i açmayacağı domain'ler (virgüllü) — mevcut yatırımcılar/portföy şirketleri, örn. `curiosityvc.com,weplayventures.com` |
| (backfill) `TRELLO_KEY` · `TRELLO_TOKEN` · `TRELLO_BOARD` | Trello kartlarını okuma |
