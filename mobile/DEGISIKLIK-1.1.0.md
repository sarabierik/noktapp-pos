# NOKTApp Garson 1.1.0 — el terminali (PDA) sürümü

Bu sürüm el terminali (PDA) kullanımı için yazıldı: iri hedefler, tek elle
kullanım ve garsonun kasaya yürümeden bitirebileceği işlemler.

## 1. Çok adisyon

Bir masada birden fazla adisyon artık telefondan yönetilir.

- Dolu masaya basınca **hangi adisyon** olduğu sorulur; her biri kendi
  etiketiyle (A, B, C) ve tutarıyla listelenir.
- **+ Yeni adisyon** aynı masaya ikinci bir adisyon açar — altı kişilik masada
  iki ayrı hesap ödeyen iki çift.
- Adisyona etiket vermek telefondan yapılır (`POST /api/mobile/orders/:id/label`).
- Sipariş eklemeden **boş adisyon açmak** artık mümkün: masaya git, adisyonu aç,
  misafirler karar verdikçe satır ekle.

## 2. Mutfağa gönder

- Adisyon ekranında **Gönder** düğmesi: açık bir adisyonu istediğin anda
  mutfağa yollar. Önceden gönderme yalnızca "siparişi al" ile birlikte
  çalışıyordu, yani satır satır doldurulan bir adisyon telefondan
  gönderilemiyordu.
- İki kez göndermek mutfağa iki kez sipariş vermez — yalnızca gitmemiş satırlar
  gider.
- Kategoriler telefonda da **kart** oldu: hepsi tek ekranda, her kartta ürün
  sayısı, basınca ürünler açılıyor. Yana kaydırma yok.

## 3. Yazdırma

- **Hesap yazdır** aynı yerde.
- **Mutfak fişini tekrar yazdır**: kaybolan ya da sıkışan fişin ikinci kopyası.
  Siparişi tekrarlamaz — yalnızca gitmiş satırların fişini basar. İstasyon
  birden fazlaysa hangisi olduğu sorulur.
- **Yazdırma kuyruğu** ekranı: son 40 iş, durumuyla birlikte. Hata veren işe
  basınca tekrar kuyruğa alınır. Garson fişin çıkıp çıkmadığını görmek için
  mutfağa yürümez.

## 4. Yetkiye göre işlemler

Terminal açılışta kasadan **o kişinin yetki listesini** alır ve düğmelerini ona
göre çizer. Sunucu da aynı listeye bakar, yani gri bir düğme ile reddedilen bir
istek asla çelişmez.

| İşlem | Gereken yetki |
|---|---|
| Sipariş alma, mutfağa gönderme, adisyon açma | `order.create` |
| Satır iptali (satıra basılı tutarak) | `order.item.cancel` |
| Masa taşıma | `order.transfer` |
| İndirim | `order.discount` |
| Hesap yazdırma / e-posta | herkes (hesabı istemek garsonun işi) |

Yetkisi olmayan işlem **gri ve "yetki yok"** yazılı görünür — gizlenmez.
Gizlenirse garson terminalde böyle bir şey olmadığını sanıp kasaya yürür.

Yetki kasadan değiştirildiği anda terminalde de değişir; uygulamanın yeniden
kurulması gerekmez.

---

## Sunucu tarafı

Bu sürüm NOKTApp POS **3.6.5 ve üzeri** ile çalışır. Yeni uç noktalar:

```
POST   /api/mobile/orders                    adisyon aç (force_new ile ikinci adisyon)
POST   /api/mobile/orders/:id/send           mutfağa gönder
POST   /api/mobile/orders/:id/label          A / B / C
POST   /api/mobile/orders/:id/transfer       masa taşı
POST   /api/mobile/orders/:id/discount       indirim
POST   /api/mobile/orders/:id/print/station  mutfak fişini tekrar yazdır
GET    /api/mobile/stations                  istasyon listesi
GET    /api/mobile/print-jobs                yazdırma kuyruğu
POST   /api/mobile/print-jobs/:id/retry      hatalı işi tekrar dene
```

Ayrıca **telefon API'sinin tamamı artık yetki kapılı**. Önceden `mobileAuth`
kimin telefonu tuttuğunu doğruluyor ama ne yapabileceğine bakmıyordu: yetkisi
olmayan bir garson telefondan satır iptal edebiliyordu. Kasa bu anahtarları ilk
günden beri sorduğu için, aynı kişi aynı işi başka bir kapıdan yaptığında da
aynı cevabı alır.

---

## Derleme

```
cd mobile
flutter pub get
flutter analyze
flutter build apk --release
```
