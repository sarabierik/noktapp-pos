# e-Fatura / e-Arşiv — QNB eSolutions

NOKTApp POS'un kestiği fatura, QNB eSolutions üzerinden GİB'e gider. Bu belge
entegrasyonun neden böyle kurulduğunu anlatır; nasıl kullanıldığını değil.

Kod: `pos-service/src/ebelge/` (`index.js` protokol, `gelen.js` gelen
faturalar, `fatura.js` adisyon→fatura, `sirla.js` parola koruması),
uçlar `pos-service/src/routes/ebelge.js`, ekranlar
`pos-service/public/screens/fatura.js`, şema
`database/migrations/2026-09-29-e-belge.sql`, testler
`pos-service/test/ebelge.js`.

---

## 1. Neden kasaya fatura kavramı girdi

Kasanın mali belgesi ÖKC fişidir. Normal satış fişle geçer ve bu modülün
hiçbir satırı çalışmaz.

Müşteri fatura isterse iş değişir: kapanmış adisyon açılır, alıcı bilgileri
girilir, belge düzenlenir. Fatura **kesilmiş fişe istinaden** düzenlenir ve
bunu üstünde yazar:

> Bu fatura 29.09.2026 tarihli 000148 no'lu ÖKC fişine istinaden düzenlenmiştir.

Bu cümle olmazsa aynı yemek iki kez beyan edilir — bir kez cihazın Z
raporunda, bir kez faturada.

Kod Noktappera'dan taşındı. Noktappera bir perakende programı ve
`invoices` / `invoice_items` tabloları zaten vardı; QNB modülü onları
okuyordu. Kasada fatura diye bir şey yoktu, bu yüzden göç yalnızca bir
entegrasyonu değil, kasaya fatura kavramını da getirdi.

Protokol tarafında hiçbir şey yeniden türetilmedi ve "iyileştirilmedi":
SOAP zarfı, UBL-TR 1.2 belgesi, mükellef sorgusu, numaralandırma ve
kurtarma disiplini QNB'nin gerçek test ortamına karşı ölçülmüş olanlar.
Değişen şey altındaki veritabanı (eşzamanlı SQLite → async MariaDB) ve
besleyen şeyin perakende faturası değil restoran adisyonu olması.

---

## 2. İkinci belgeyi engelleyen iki kural

Bu entegrasyonda yanlış gitmenin en pahalı yolu, bir yemek için **iki yasal
belge** üretmektir. Bunu engelleyen iki kural var ve ikisi de teste bağlı.

**ETTN gönderilmeden ÖNCE yazılır.** Fatura numarası da öyle. QNB'den yanıt
gelmezse yeni kimlik üretilmez: belge önce sorgulanır, sonra **aynı**
kimlikle yeniden gönderilir. e-Arşiv tarafında aynı `islemId` ikinci kez
gönderilince QNB aynı faturayı döner — bu ölçüldü, zaman aşımından sonra
tekrar göndermek güvenli. Sonucu bilinmeyen fatura ekranda "Sonuç
bilinmiyor" diye durur ve ekran açıkça "yeni fatura KESMEYİN" der.

**Bir adisyon satırı en fazla bir kez faturalanır.** Bunu koruyan şey ekran
değil, veritabanı: `invoice_items` üzerinde `(client_id, order_item_id)`
benzersizdir. Bölünmüş hesapta aynı kebap iki müşteriye faturalanamaz, iki
istasyondan aynı anda denense bile. Fatura iptal edilince modül satırın
`order_item_id` alanını NULL'a çeker (ad ve tutarlar kayıtta kalır), böylece
satır yeniden faturalanabilir.

---

## 3. Restoran kuralları

**İkram 0,00 görünür.** İkram edilen satır faturadan düşürülmez; adı ve
miktarıyla, 0,00 olarak durur. Düşürmek faturayı masaya gelenle
uyuşmaz hale getirir ve ilk bakılan şey budur. Hesap geneline yazılan ikram
ödemesi ise satır bilgisi taşımaz; oranlı olarak satırlara dağılır.

**Servis ücreti `cac:AllowanceCharge`, indirim değil.** "Servis ücreti"
adında bir ürün uydurmak satılmamış bir şeyi satış raporuna ve stoğa sokar.
İndirim ise bilerek AllowanceCharge YAPILMAZ: kasa hesap geneli indirimi
zaten satırlara kuruş kuruş (en büyük kalan yöntemiyle, `util/vat.js`)
yayıyor ve ÖKC fişi o dağılımla basıldı. İndirimi belge düzeyinde tek bir
kalem olarak taşıyan fatura daha düzgün UBL olurdu ve aynı yemek için mali
cihazın beyan ettiğinden başka bir KDV dağılımı beyan ederdi. Fiş kazanır.

**Numara tek yerden verilir.** Bütün istasyonlar bu tek servisle konuşur ve
numara kendi satırını kilitleyen bir işlemin içinde alınır. Aynı saniyede
"Fatura" diyen iki kasiyer ardışık numara alır; `(client_id, full_no)`
benzersiz anahtarı son duvardır.

---

## 4. QNB'nin söyledikleri (destek kaydı 02047654, 30.09.2026)

* Canlı adresler **bütün müşteriler için aynıdır** — `VARSAYILAN.canli`
  içindekiler.
* **BAG31527 ERP kodu canlı için bir kez, bizim tarafımızdan** tanımlatılır;
  sonrasında o kodla gelen her müşteri otomatik kaydedilir. İşletmenin
  ayrıca bir şey yapması gerekmez. *(Yapılacak: canlıya geçişte QNB'den bu
  tanımı isteyin.)*
* e-Arşiv **test** ortamında da BAG31527 tanımlandı; ERP kodsuz yeniden
  deneme artık tetiklenmemeli. Kod yerinde bırakıldı — hiç çalışmayan bir
  yedek bedavadır ve yeniden çalıştığı gün bunu başarısız bir faturadan
  değil bir uyarıdan öğreniriz.
* **Portal parolası üç ayda bir değişir.** QNB'nin kendi cümlesi: yeni parola
  web servis ayarlarına da yazılmazsa program eski parolayla denemeye devam
  eder ve **kullanıcı bloke olur**. Bu yüzden portal kullanıcısından ayrı bir
  web servis kullanıcısı önerilir.
* Rate limit: dakikada 180 istek.
* e-Fatura numarasını kendimiz vermemiz (seri + yıl + sıra) `faturaNoUret`
  kullanmaktan **daha uygundur**.
* Mali mührü **QNB atar**; biz imzasız UBL göndeririz.
* e-Arşiv faturasının alıcıya e-postası **QNB tarafından** gönderilir ve
  UBL'deki `Gönderim Şekli` notuna bakar: fatura üstünde e-posta varsa
  ELEKTRONIK, yoksa KAGIT.
* TİCARİ faturaya yanıt `belgeGonderExt` + `UYGULAMA_YANITI_UBL` ile verilir.

### Parola kilidi

Yanlış parola bir kez görüldüğünde modül **her şeyi durdurur**
(`kimlikKilidi`). Ayarlar kaydedilene kadar — yeni parolanın gelebileceği
tek an — QNB'ye tek bir istek daha gitmez; beş dakikada bir çalışan kuyruk
taraması da sessiz kalır. Dayanıklılık gibi görünen otomatik tekrar, burada
restoranı hattan düşüren şeyin ta kendisi.

---

## 5. Ortam ayrımı

Test ortamı bizim hesabımızdır, canlı işletmenin kendi hesabı. Aralarındaki
duvar birkaç yerde birden kuruludur:

* Ortam değişince kayıtlı parolalar silinir; test parolası canlıya taşınmaz.
* Canlıda VKN Ayarlar'daki işletme vergi numarasıdır; başka VKN reddedilir.
* Canlıda test adresi kullanılmaz.
* Numara sırası ortam başına sayılır: testte harcanan numaralar canlı sırayı
  kaydırmaz.
* Mükellef sorgusu önbelleği ortam anahtarlıdır: test sicili canlı kararı
  vermez.
* Testte **oluşmuş** belge canlıya taşınmaz; hiç oluşmamışsa kimlikler
  sıfırlanıp bu ortamda yeni kimlikle gönderilir.
* Gelen faturalarda ortam benzersiz anahtarın parçasıdır: aynı ETTN test ve
  canlıda ayrı satırdır, testte çekilmiş belge canlı listede görünmez ve
  yanıtlanamaz.

---

## 6. Parolalar

`sirla.js` Windows DPAPI ile sarar ve PowerShell'e **stdin üzerinden** verir;
parola hiçbir zaman komut satırında durmaz. DPAPI bulunamazsa değer `duz:`
diye işaretlenir, `korumaVar()` false döner ve ekran bunu açıkça yazar.

Parola üç yere **yazılmaz**: `ebelge_log` (iletişim kaydı), ayar ucunun
yanıtı (ekrana yalnızca "parola var mı" bilgisi gider), ve buluta giden
gece yedeği. Sonuncusu bu çalışmada çıkan ikinci kusurdu: yedek düz bir
mysqldump'tı ve QNB kullanıcı adıyla parolasını da taşıyordu. Artık bulut
yedeği iki geçişte alınır — `np_settings` hariç her şey, sonra
`BULUTA_GITMEZ` anahtarları süzülmüş `np_settings` (bkz. `src/backup.js`).
Yerel yedek eksiksiz kalır: bina dışına çıkmaz ve ondan dönen bir kurulum
işletmeden QNB parolasını yeniden bulmasını istememeli.

---

## 7. Durumlar

`edoc_state`: `gonderiliyor` · `kuyrukta` · `tamam` · `hata` · `belirsiz` ·
`iptal`.

e-Arşiv eşzamanlıdır: `faturaOlusturExt` tek çağrıda numarayı, ETTN'yi ve
görüntüleme bağlantısını döner. e-Fatura kuyrukludur: `belgeGonderExt` bir
`belgeOid` döner, sonuç `gidenBelgeDurumSorgulaExt` ile izlenir ve beş
dakikada bir taranır.

**`durum 3` tek başına başarı değildir.** "İşlendi" QNB'nin kendi işini
bitirdiği anlamına gelir, faturanın alıcıya ulaştığı anlamına gelmez. Karar
GİB zarf yanıt koduna göre verilir: canlı testte `durum 3` + `1172
TPS_POSTA_KUTUSU_YETKISI_YOK` + `ulastiMi false` görüldü — fatura
gitmemişti. `1300` ya da `ulastiMi true` tamam; `1000/1100/1200/1220`
bekliyor; gerisi hata.

---

## 8. İptal ve iade

e-Arşiv faturası önce QNB'de iptal edilir, sonra yerelde. QNB kabul etmezse
fatura iptal EDİLMEZ.

e-Fatura programdan iptal edilemez — GİB'e iletilmiştir. Çözüm iade
faturasıdır (`InvoiceTypeCode IADE` + asıl faturaya `BillingReference`) ya da
alıcıyla GİB portalı üzerinden iptal süreci. İade faturasının kalemleri
adisyon satırına bağlanmaz: o satırlar asıl faturanın ve benzersiz anahtar —
haklı olarak — reddeder.

---

## 9. Gelen faturalar

Tedarikçinin kestiği e-Faturalar QNB posta kutusundan çekilir. Çekme
penceresi son çekmeden **iki gün öncesinde** başlar: QNB geliş tarihine göre
listeler ve bir önceki çekme sürerken gelen belge aksi halde bir daha
görünmezdi. Bir belgeyi tekrar okumak bedava, kaçırmak değil.

Yalnız **TİCARİ** faturaya kabul/red yanıtı verilir ve GİB süresi geliş
tarihinden itibaren **8 gündür**; süre dolarsa fatura kabul edilmiş sayılır.
TEMEL faturaya yanıt verilmez ve ekranda düğmesi yoktur — basılsa yasal
olarak hiçbir şey yapmazdı.

Yanıtın kendi ETTN'si de gönderilmeden önce yazılır; QNB yanıtı reddederse
tekrar **aynı kimlikle** gider, tedarikçiye ikinci bir yanıt ulaşmaz.

"Alışa aktar" taslak bir stok giriş belgesi açar — taslak, çünkü satırlar bir
insan tarafından ürünlere eşleştirilip onaylanana kadar stokta hiçbir şey
kımıldamaz. Noktappera boş bir taslak açıp satırları PDF'ten yeniden
yazdırıyordu; kasa UBL'i zaten okuduğu için satırlar (eşleşmemiş, yalnız
`raw_name`) belgeye yazılır ve mevcut eşleştirme ekranı kendi işini yapar.

---

## 10. Bilinen boşluklar

* DPAPI yolunun gerçek Windows makinesinde çalıştığı **doğrulanmalı**;
  Linux tezgâhında `korumaVar()` doğal olarak false döner.
* Canlı ortam için BAG31527'nin QNB'de tanımlatılması gerekiyor (§4).
* Gelen fatura çekmesi elle yapılır; 30 dakikalık otomatik çekme henüz yok.
* `faturaNoUret` kullanılmıyor; numarayı kendimiz veriyoruz (QNB uygun
  buluyor, §4).
