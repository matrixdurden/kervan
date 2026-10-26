# kervan

Tedarikçiden mal alıp satıcılara veren küçük işletmeler için alış, satış, emanet, stok, cari hesap ve
ortak kasası uygulaması. Ortaklar aynı işletmeye davet koduyla katılır ve her şeyi birlikte görür.

- **Ana ekran:** üstte alacak, kasa ve bu ayın kârı; büyük renkli düğmeler (Satışlar, Alışlar, Tahsilatlar,
  Giderler) ve altında bölümler. Her bölüm kendi sayfasında, en üstte büyük bir "+ Yeni …" düğmesiyle açılır.
- **Ürünler:** fotoğraf, barkod, **çeşitler** (renk, beden… her biri ayrı stokla, listede tek kartta), KDV oranı,
  **kâr marjı %** (satış fiyatı ile ortalama maliyetten), **azalınca uyar** sınırı (ana ekranda zil ve uyarı bandı),
  depodaki ve satıcılardaki (emanet) miktar. Barkod telefon kamerasıyla okutulur: ürün listesinde okutunca ürün açılır
  (yoksa o barkodla yeni ürün formu gelir), alış/satış/emanet formunda okutunca ürün satıra eklenir, tekrar okutunca
  miktarı artar.
- **Fiş ve fatura bilgisi:** satış kaydedilince satış fişi ya da KDV dökümlü fatura bilgisi (proforma) tek dokunuşla
  WhatsApp'tan gönderilir ya da yazdırılır. Fatura bilgisi e-Fatura / e-Arşiv yerine geçmez; resmi e-belge için GİB'e
  bağlı bir özel entegratör gerekir.
- **Faturadan alış:** tedarikçinin faturası seçilir, ürünler, miktarlar ve fiyatlar okunup alış olarak hazırlanır;
  onay ekranında ürün eşleşmeleri düzeltilir, yeni ürünler ve yeni tedarikçi aynı anda oluşturulur. e-Fatura XML
  yapay zekâsız ve kesin okunur. PDF ve fotoğraf anahtarsız ve ücretsiz okunur: Cloudflare Workers AI'ın ücretsiz
  kotasıyla (tüm işletmeler için günlük ortak sınır). İsteyen işletme kendi Gemini anahtarını da ekleyebilir.
- **Giderler:** Ayarlar'dan düzenlenen kategorilerle (kira, yakıt, vergi…); raporlarda kategoriye göre toplam.
- **Raporlar:** dönem kârı ve marjı, en çok kâr getiren ürünler, kategoriye göre giderler, en çok borcu olanlar,
  azalan ürünler.
- **Tedarikçiler:** TL, dolar ya da euro ile alış ve ödeme. Dövizli alışta maliyet o günün kuruyla TL'ye çevrilir;
  kur günün Avrupa Merkez Bankası kurundan önerilir.
- **Satıcılar:** veresiye satış ve tahsilat; **emanet** mal verme, rafta **sayım** (kalanı yaz, satılanı uygulama
  hesaplar) ve **iade**. Hesap ekstresinde her hareketten sonraki bakiye görünür.
- **Kasa:** dönem kârı (satış − satılan malın maliyeti − giderler), ortakların yüzdeleriyle kâr payı, her ortağın
  elindeki işletme parası, koyduğu/çektiği para ve toplam hakkı. Gider, para koyma/çekme ve ortaklar arası devir.
- **Ürün ortaklıkları:** bazı ürünlerde ortaklık farklıysa (örneğin çayda kuzen de %30 ortak) bir ortaklık açılır;
  o ürünlerin satış kârı kendi yüzdeleriyle, geri kalan her şey genel paylarla bölünür. Gider bir ortaklığa
  bağlanabilir. Ortak, uygulamayı kullanmayan biri de olabilir (**dışarıdan ortak**): kâr payı, koyduğu ve aldığı
  para tutulur, parasını uygulamadaki bir ortak teslim alır ya da verir.
- **Cariler:** satıcı/tedarikçi eklerken telefon rehberinden seçilebilir (şimdilik sadece Android Chrome destekliyor).
- **Defter:** her işlem silinemeyen bir kayıttır. Yanlış kayıt silinmez, sebebi yazılarak iptal edilir; kimin
  girdiği ve kimin iptal ettiği her zaman görünür. Kaydın hemen ardından çıkan **Geri al** da kaydı iptal eder.
- **Türkçe ve Arapça** arayüz (sağdan sola düzen dahil).

Canlı: https://kervanim.web.app (eski adres https://kervan-7c9f64.web.app de aynı uygulamayı sunar)

Telefonda ve bilgisayarda çalışan bir web uygulaması (PWA). Barındırma ve veritabanı Firebase'in ücretsiz
planında. Açık kaynak, MIT lisanslı.

## Yapı

```
public/              Yayınlanan site (build adımı yok)
  index.html         Ekranlar
  style.css          Görünüm (açık/koyu tema)
  app.js             Giriş, işletmeler, davet, menüler, dil
  firm.js            Ana ekran ve bölüm sayfaları (satışlar, alışlar, ürünler, cariler, kasa, raporlar, ayarlar…)
  importer.js        Faturadan alış: dosya seçme, okuma, onay ekranı
  invoice.js         e-Fatura (UBL-TR) XML okuyucu, Gemini ile PDF/fotoğraf okuma, ürün/tedarikçi eşleştirme
  ai.js              Anahtarsız fatura okuma: fotoğrafı küçültür, PDF'i metne/resme çevirir, Worker'a yollar
  receipt.js         Satış fişi ve fatura bilgisi (resim, yazdırma), WhatsApp paylaşımı
  party.js           Bir satıcının/tedarikçinin hesabı, emanetteki malı ve ekstresi
  forms.js           Bütün formlar (ürün, cari, alış/satış/emanet, sayım/iade, kasa, paylar, iptal)
  views.js           Ortak liste parçaları
  data.js            Firestore'a yazan işlemler
  ledger.js          Stok, emanet, maliyet, bakiye, kasa ve kâr hesabı (saf fonksiyonlar)
  money.js           Para, miktar ve kur okuma/biçimleme
  rates.js           Döviz kuru önerisi
  photos.js          Ürün fotoğrafı seçme ve küçültme
  scanner.js         Kamerayla barkod okuma
  contacts.js        Telefon rehberinden kişi seçme
  i18n.js            Türkçe ve Arapça metinler
  sw.js              Çevrimdışı açılış için service worker
  firebase-config.js Firebase proje ayarları
firestore.rules      Veritabanı güvenlik kuralları
worker/              Anahtarsız fatura okuma için Cloudflare Worker (Workers AI; Firebase girişini doğrular)
test/                Hesap, para, çeviri ve Worker testleri
```

## Veri

Para her yerde **kuruş (ya da cent) cinsinden tam sayıdır** (12,50 TL → `1250`).

- `firms/{id}`: işletme (`name`, `code`, `members: [uid]`, `people: { uid: { name, color } }`,
  `shares: { ortakId: yüzde }` genel paylar, `guests: { gId: { name, color } }` dışarıdan ortaklar,
  `deals: { dId: { name, products: [ürünId], shares: { ortakId: yüzde } } }` ürün ortaklıkları). Sadece ortaklar okur.
- `firms/{id}/products/{id}`: `name`, `unit`, `price` (satış fiyatı), `barcode`, `thumb` (küçük fotoğraf),
  `stock`, `value` (depodaki malın toplam TL maliyeti), `lastCost`, `consigned` (satıcılardaki toplam miktar).
- `firms/{id}/images/{ürünId}`: ürünün büyük fotoğrafı. Firebase'in ücretsiz planında dosya deposu (Storage)
  olmadığı için fotoğraf telefonda küçültülüp (≈8 KB / ≈70 KB JPEG) veritabanına yazılır.
- `firms/{id}/parties/{id}`: `kind: seller | supplier`, `name`, `phone`, `note`, `currency` (tedarikçide),
  `balance` (kişinin para biriminde; satıcıda + "bize borçlu", tedarikçide + "biz borçluyuz"),
  `shelf: { ürünId: { stock, value, price } }` (satıcıdaki emanet mal).
- `firms/{id}/moves/{id}`: hareket. `type`: `purchase`, `payment`, `sale`, `collection`, `consign`, `consignSale`,
  `return`, `expense`, `capitalIn`, `withdraw`, `transfer`, `opening`. Ürünlü hareketlerde
  `lines: [{ product, name, unit, qty, price, cost }]`, diğerlerinde `amount`; dövizde `currency` ve `rate`;
  para hareketlerinde `holder` (parası değişen ortak), devirde `to`. Silinemez; sadece bir kez iptal edilebilir.
- `firms/{id}/accounts/{uid}`: ortağın `cash` (elindeki işletme parası) ve `capital` (koyduğu − çektiği).
- `firms/{id}/months/{YYYY-MM}`: aylık `revenue`, `cogs`, `expenses` ve aynısı kova bazında
  `by: { general | dId: {…} }`. Satış satırına ürünün o anki ortaklığı (`deal`) yazılır; ortaklık sonradan
  değişse de geçmiş kârın hangi kovaya ait olduğu bozulmaz. Bir kovanın kârı, o ortaklığın güncel yüzdeleriyle
  bölünür (silinmiş ortaklığınki genel paylarla).
- `invites/{KOD}`: davet kodu → işletme.

Asıl kayıt defterdir. Ürün, cari, ortak hesabı ve ay belgelerindeki rakamlar her hareketle aynı batch'te
`increment` ile güncellenen özetlerdir. Böylece uygulama her açılışta bütün defteri okumaz (ücretsiz planın okuma
kotası korunur) ve internetsiz de kayıt girilir. Bir şey tutmazsa işletme menüsündeki **Defterden yeniden
hesapla** bütün özetleri hareketlerden baştan kurar.

Maliyet ağırlıklı ortalamayla hesaplanır ve satış anında satıra (`cost`) yazılır; kâr bundan çıkar. Emanete giden
mal maliyetiyle birlikte satıcının rafına geçer; sayımda satılan kısım raftaki ortalama maliyetle kâra yazılır.

Bilinen sadeleştirme: dövizli borçta kur farkı (alış günü ile ödeme günü kuru arasındaki fark) kâra ayrıca
yazılmaz; ödeme, ödeyen ortağın kasasından o günün kuruyla TL olarak düşer.

## Geliştirme

```bash
npm run dev    # emülatörlerle yerel çalıştır → http://localhost:5000 (veri paneli: http://localhost:4000)
npm test       # hesap, para ve çeviri testleri
```

`localhost` üzerinden açıldığında uygulama otomatik olarak emülatöre bağlanır; gerçek veritabanına dokunmaz.
Emülatör için Java gerekir.

## Kendi Firebase'ine kurmak

1. `firebase login`
2. [Firebase konsolunda](https://console.firebase.google.com) proje oluştur. **Authentication → Google** girişini aç,
   **Firestore** veritabanı oluştur.
3. Proje ayarlarından web uygulaması ekle, `firebaseConfig` değerlerini `public/firebase-config.js` içine yapıştır.
4. `firebase use --add` ile projeyi seç, sonra `npm run deploy` (site, güvenlik kuralları ve indeksler birlikte gider).
5. İsteğe bağlı, anahtarsız fatura okuma: `worker/index.js` içindeki `PROJECT` ve `ORIGINS`'i kendi projene göre
   değiştir, `npx wrangler login` ile ücretsiz Cloudflare hesabına gir, `npm run deploy:ai` çalıştır ve çıkan
   `*.workers.dev` adresini `public/firebase-config.js` içindeki `aiReaderUrl`'e yaz. Boş bırakılırsa işletmeler
   PDF/fotoğraf için kendi Gemini anahtarını kullanır.

## Lisans

MIT
