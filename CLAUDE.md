# Claude için proje bağlamı

Mimari ve akış için önce `README.md` oku. Bu dosya onun kapsamadığı
**operasyonel gerçekleri, bilinen tuzakları ve açık işleri** taşır.

---

## Altyapı — nerede ne çalışıyor

| | |
|---|---|
| Vercel takımı | VALIDFOR (`team_rnTsaksEXAE1ABJ9cTyycYa8`) |
| Vercel projesi | `validfor` (`prj_kFQJS1QBGNOrIErTSTLSe00szwdv`), framework Hono, Node 24 |
| Deploy kaynağı | `demo430/Validfor-HubSpot` → branch `main` (private) |
| Canlı URL | https://validfor.vercel.app |
| Sağlık kontrolü | `GET /` → `{ok, service, version, commit, ts}` |

`commit` alanı canlıdaki sürümü söyler — bir değişikliğin gerçekten yayına
çıkıp çıkmadığını buradan doğrula.

### Erişim notu

Projenin geçmişinde birden fazla GitHub hesabı dolaştı: `mustafakman711`,
`furkangultekin-Validfor`, `demo430`. **Kod `demo430/Validfor-HubSpot`'ta.**
Bir oturumun push yetkisi yoksa sebep genelde budur — oturum yanlış hesabın
reposuna bağlanmıştır. Oturum kaynağı `demo430/Validfor-HubSpot` olmalı.

---

## Ortam değişkenleri

Vercel → Settings → Environment Variables altında tanımlı:

| Değişken | Ne için |
|---|---|
| `FIREFLIES_API_KEY` | Transkript çekme |
| `FIREFLIES_WEBHOOK_SECRET` | Webhook + manuel tetikleme kimliği |
| `HUBSPOT_TOKEN` | CRM yazma/okuma |
| `ANTHROPIC_API_KEY` | Sınıflandırma (`claude-sonnet-5`) |
| `APOLLO_API_KEY` | Şirket/kişi zenginleştirme |
| `CRON_SECRET` | Vercel cron'un bearer kimliği |
| `GOOGLE_CALENDAR_ID` | **Virgülle ayrılmış çoklu takvim** kabul eder |
| `GOOGLE_SA_EMAIL` | Service account — takvimler bu hesapla paylaşılmalı |
| `GOOGLE_SA_PRIVATE_KEY` | Service account anahtarı |
| `VALIDFOR_INTERNAL_DOMAINS` | İç katılımcı sayılan domainler |
| `VC_EXCLUDE_DOMAINS` | Asla otomatik VC kartı açılmayacak domainler |

| `VALIDFOR_OWNER_MAP` | Owners API'si 403 verirse Deal owner yedek eşlemesi |

Ayrıca kodda okunan ama yukarıda listelenmeyenler: `HUBSPOT_API_BASE`
(EU portal → `https://api-eu1.hubapi.com`), `APOLLO_LIST_NAMES` (virgüllü liste
adları), `GOOGLE_CALENDAR_API_KEY` (service account yoksa yalnız herkese açık
takvim okur), `TRELLO_KEY` · `TRELLO_TOKEN` · `TRELLO_BOARD` (yalnız backfill).

`CALENDLY_TOKEN` **bilinçli olarak kullanılmıyor** — aşağıya bak.

---

## Bilinen tuzaklar

### Calendly token'ı bozuk
`CALENDLY_TOKEN` 403 "Insufficient scope" veriyor, yani `lib/calendly.ts`
hiçbir rezervasyonu göremiyor. Bu yüzden `lib/gcal.ts` içindeki
`syncCalendarDemoDeals` yazıldı: Calendly rezervasyonları organizatörün
Google Takvim'ine düştüğü için demolar oradan yakalanıyor. **Calendly API'sine
bağımlılık yok.** Token'ı düzeltmeye çalışmadan önce bunun zaten çözüldüğünü
hatırla.

Kod yolu hâlâ duruyor: `CALENDLY_TOKEN` env'de tanımlıysa `stage-sweep` içinde
`calendly-sync` de koşar (`src/index.ts`), sadece boş sonuç döner. Yani günlük
koşumda üç takvim adımı var — `calendar-sync` (VC), `calendar-demos` (demo,
takvimden) ve `calendly-sync` (demo, Calendly API'sinden; şu an ölü).

### Deploy edilen `vercel.json` repodakinden farklı olabilir
Kod bir dönem GitHub web arayüzünden elle yüklendi ("Add files via upload").
Eski dosyalar tam temizlenmediyse deploy edilen `vercel.json` repodakinden
sapabilir. **Belirti:** `apollo-sync` günde bir yerine 15 dakikada bir koşuyor
(Vercel runtime loglarından görülür). **Repodaki `vercel.json` artık doğru**
(2026-08 kontrolü) — sapma varsa deploy tarafındadır, repo tarafında değil.
Doğrusu:

```json
"crons": [
  { "path": "/api/apollo-sync", "schedule": "0 7 * * *" },
  { "path": "/api/stage-sweep", "schedule": "30 7 * * *" }
]
```

Vercel Hobby'de cron sınırı 2'dir — bu yüzden `calendar-sync` ve
`calendar-demos` ayrı cron değil, `stage-sweep` içinden çağrılır.

### Owners API'si scope istiyor — Deal owner sessizce boş kalır
`/crm/v3/owners` çağrısı `crm.objects.owners.read` scope'unu ister. Private
app'e bu izin verilmemişse HubSpot **403 MISSING_SCOPES** döner;
`resolveOwnerId` hatayı yutup `""` döndüğü için (yanlış kişiye atamamak adına)
`hubspot_owner_id` **sessizce boş kalır** — `deal_owner_validfor` dolduğu için
sorun ilk bakışta görünmez. **Belirti:** kartta "Deal Owner Validfor" yazıyor
ama kanban'da Deal owner boş.

**Teşhis:** `curl -s "https://validfor.vercel.app/api/backfill-owners?dry=1"
-H "x-webhook-secret: SECRET"` → `scanned:0` + `errors:1` ise sebep budur
(Vercel logunda `[owner-backfill] owner listesi alinamadi: HubSpot 403`).

**Kalıcı çözüm:** HubSpot → Ayarlar → Integrations → Private Apps → app →
Scopes → `crm.objects.owners.read` işaretle → Commit changes. Token değeri
değişmez, redeploy gerekmez.

**Yedek yol:** Scope açılamıyorsa `VALIDFOR_OWNER_MAP` env'i devreye girer —
virgülle ayrılmış `anahtar:ownerId` çiftleri, anahtar e-posta ya da ad olabilir
(ad karşılaştırması aksan/noktalama toleranslı). Owners API'si çalışıyorsa
**önce o** kullanılır; env yalnız son çaredir. Yeni seat açıldığında bu listeyi
elle güncellemeyi unutma.

### HubSpot arama limiti
4 istek/saniye. Toplu döngülerde `await sleep(350)` freni var — kaldırma.

### Apollo kredi koruması
Zenginleştirilen şirkete `apollo_enriched_at` damgası basılır; damgalı kayıt
tekrar sorgulanmaz. Loglarda `complete=N` bunu gösterir. Bu damgayı atlayan
bir kod yolu eklersen krediler hızla tükenir.

---

## Değişmemesi gereken davranış kuralları

Bunlar kullanıcının açık kararları — "iyileştirme" niyetiyle değiştirme.

**Demo kartı `Unassigned`'a düşer**, `Scheduled`'a değil. Taşıma kararı ekibin;
toplantı gerçekleşince otomasyon `Meeting`'e alır. (`lib/gcal.ts`)

**Başlığında `demo` geçen etkinlik asla VC adayı olamaz.** "X Intro & Demo"
gibi müşteri tanışmaları `intro` sinyaliyle VC pipeline'ına sızıyordu.

**VC tespiti bilinçli olarak geniş.** Yanlış pozitif kart elle silinebilir,
kaçırılan fon hiç görünmez. Daraltma önerisi gelirse bu gerekçeyi hatırlat.

**Ortalama bilet `maxTicketSize`'a yazılır**, minimuma asla.

**Boş-alan kuralı:** insanın girdiği değer asla ezilmez. Manuel bırakılan
alanlar: Sales kartında Likelihood / Demo Status / Validfor Priority, VC
kartında Likelihood.

**Deal owner iki alanda tutulur.** `deal_owner_validfor` (özel metin alanı,
toplantıyı yapan kişinin adı) ve `hubspot_owner_id` (HubSpot'un standart
alanı — kanban kartı, raporlar ve görev yönlendirmesi bunu kullanır).
Otomasyon ikisini de yazar; owner eşleşmesi **e-posta** üzerinden yapılır
(ad tekrar edebilir), bulunamazsa alan boş kalır — yanlış kişiye atama yok.
Elle atanmış owner asla ezilmez. Ekip HubSpot kullanıcısı değilse
`hubspot_owner_id` boş kalır, metin alanı yine dolar.

**Deal owner = Deal Owner Validfor.** Karttaki `deal_owner_validfor` kim ise
standart `hubspot_owner_id` alanı da o kişiye ayarlanır (demo yapan herkese seat
alındı). Eşleşme önce e-posta, tutmazsa tam ad üzerinden yapılır; ad birden çok
kullanıcıya denk geliyorsa alan **boş bırakılır** — yanlış kişiye atama yok.
Elle atanmış owner asla ezilmez. Geriye dönük süpürme: `/api/backfill-owners`.

**Serbest webmail'den şirket kaydı açılmaz** (`FREE_EMAIL_DOMAINS`,
`lib/upsert.ts`). Liste Polonya ve Çin webmail'leriyle genişletildi; benzer
bir sızıntı görülürse listeye eklenir.

**Tek istisna — Calendly formundaki şirket adı.** Kişisel e-postayla
(`gmail.com`, `icloud.com`) alınan demo rezervasyonları CRM'de hiç
görünmüyordu: `calendar-demos` domain bulamadığı için kart açmıyor, kayıt
ancak toplantı gerçekleşip transkript işlenince oluşuyordu. Calendly form
cevaplarını aktardığı **takvim etkinliğinin açıklamasına** yazdığı için
(`Company Name: CHG`) bu ad artık okunuyor ve kart o adla açılıyor
(`extractCompanyNameFromDescription`, `lib/gcal.ts`). Kural çiğnenmiyor:
**webmail domain'i hiçbir zaman şirket kaydına yazılmaz**, yalnızca insanın
beyan ettiği ad kullanılır. Şirket adı da yoksa aday yine oluşmaz.
Calendly API'sine bağımlılık yok — bilgi takvimden geliyor.

**Aynı ad transkript yolunda da kullanılır.** Toplantı gerçekleştikten sonra
`processTranscript`, karşı tarafta şirket domain'i yoksa ve Claude transkriptten
şirket adı çıkaramadıysa takvim etkinliğini toplantı saatine + katılımcıya göre
bulup oradaki adı akışa geri verir (`findCalendarCompanyName`, `lib/gcal.ts`).
Bu olmadan 30 dakikalık dolu bir demo bile `skipped: harici sirket/katilimci yok`
ile CRM'e hiç girmiyordu (Abanoub/Julphar, Luis/LuceNox vakaları). Takvim
okunamazsa eski davranışa düşer — pipeline kırılmaz.

**Kart adı domain'e değil beyan edilen ada göre açılır.** Kurumsal e-postada da
formdaki `Company Name` tercih edilir (kart `thermofisher.com` değil "Thermo
Fisher Scientific" olur); domain yine şirket kaydının `domain` alanına yazılır,
eşleştirme ve Apollo zenginleştirme oradan çalışmaya devam eder.

**Şirket adı eşleştirmesi toleranslıdır.** Aynı firmadan iki kişi forma
"Julphar" ve "Julphar Pharmaceutical" yazınca iki kart açılıyordu.
`sameCompanyName` (`lib/upsert.ts`) kelime sınırındaki öneki aynı şirket sayar;
"Global" ile "Terra Link Global" gibi son-kelime kesişmeleri eşleşmez.

---

## Doğrulama komutları

Tüm yazma uçları önizleme destekler — `?dry=1` hiçbir şey yazmaz.

```bash
# Canlı sürüm
curl -s https://validfor.vercel.app/

# Önizleme (SECRET = FIREFLIES_WEBHOOK_SECRET)
curl -s "https://validfor.vercel.app/api/stage-sweep?dry=1"      -H "x-webhook-secret: SECRET"
curl -s "https://validfor.vercel.app/api/calendar-demos?dry=1"   -H "x-webhook-secret: SECRET"
curl -s "https://validfor.vercel.app/api/calendar-companies?dry=1" -H "x-webhook-secret: SECRET"

curl -s "https://validfor.vercel.app/api/backfill-owners?dry=1"   -H "x-webhook-secret: SECRET"

# Gerçek koşum — stage-sweep içinde calendar-sync + calendar-demos da çalışır
curl -s -X POST "https://validfor.vercel.app/api/stage-sweep" -H "x-webhook-secret: SECRET"
```

Anahtarsız `GET` her uçta rotanın ne yaptığını anlatan bir açıklama döner —
deploy'un güncel olup olmadığını anlamanın hızlı yolu.

---

## Açık işler

- [ ] **Deploy takılı** — canlı `GET /` `commit: 5501bf1` diyor, ama `main`
      `7a9db38`'de. Vercel'deki son production deployment `readyState: BLOCKED`.
      Yani `main`'deki son commit hiç yayına çıkmadı; önce bunu çöz, sonra
      aşağıdaki doğrulamaları yap.
- [x] **`vercel.json` cron'u** — repodaki dosya doğru (`0 7 * * *` /
      `30 7 * * *`). Geriye yalnız **deploy edilen** sürümü Vercel runtime
      loglarından doğrulamak kaldı.
- [ ] **Owner backfill'i koş** — `backfill-owners?dry=1` ile önizle, sonra POST.
      Yanıttaki `unresolved` altında kalan adlar HubSpot'ta kullanıcı olarak
      yok ya da ad birden çok kişiye denk geliyor demektir; onlar elle atanır.
- [ ] **`demo@validfor.com` takvimini doğrula** — `GOOGLE_CALENDAR_ID`'ye
      eklendi mi ve takvim `GOOGLE_SA_EMAIL` ile paylaşıldı mı?
      `calendar-demos?dry=1` ile kontrol et.
- [x] **Repo hijyeni** — kök dizin temiz; `api/`, `lib/`, `src/`, `scripts/`
      dışında başıboş `.ts` dosyası yok.

---

## Dil

Kod yorumları ve commit mesajları Türkçe, ASCII (Türkçe karakter yok —
`sirket`, `toplanti` gibi). Kullanıcıya Türkçe yanıt ver. Claude'a giden
promptlar ve CRM'e yazılan içerik İngilizce.
