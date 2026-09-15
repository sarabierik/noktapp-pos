# NOKTApp Garson 1.2.0 — karekod ile bağlanma

Bu sürümde tek bir şey değişti, ama en sık takılınan yer orasıydı: telefonun
kasaya bağlanması.

## Eskiden

Garson telefonda **altı haneli kodu**, **kullanıcı adını** ve **telefon
şifresini** yazıyordu. Kasa bulunamazsa bir de **IP adresini** yazması
gerekiyordu. Dört alan, ve üçü yanlış yazılabiliyordu.

En sık görülen çıkmaz da buradaydı: garsonlar kasada **PIN ile** açılır, telefon
şifresi çoğu zaman hiç tanımlı değildir. Yani ilk gün çalışan garsonun
bağlanabilmesi için önce kasadan ona bir telefon şifresi verilmesi gerekiyordu.

## Şimdi

Kasada **Ayarlar → Cihazlar → Telefonlar → "Telefon bağla"**:

1. Kasa "kimin adına?" diye sorar — listeden personel seçilir.
2. Ekranda **karekod** çıkar. Yanında altı hane ve kasanın adresi da durur.
3. Telefonda **NOKTApp Garson → "Karekodu okut"**. Kareyi göster, bitti.

**Şifre sorulmaz.** Kullanıcı adı sorulmaz. Adres sorulmaz — karekod kasanın
adresini de taşır, telefon kasayı aramaz bile.

Telefon, seçilen personelin **yetkileriyle** açılır. Garsonun kasada iskonto
yetkisi yoksa telefonda da yoktur; satır silemiyorsa telefonda da silemez.
Yetkiyi ayrıca telefon için ayarlamak diye bir şey yok, tek yer var.

## Güvenlik — neden şifre sormuyor

Karekodun içinde altı hane değil, **32 haneli bir jeton** var. Bu jeton yalnızca
kasanın ekranındaki karede bulunur, hiçbir kayda ve hiçbir adrese yazılmaz.

- **10 dakika** yaşar.
- **Tek telefon** içindir; ikinci telefon aynı kareyi okutursa reddedilir.
- İki telefon aynı anda okutursa yalnızca biri bağlanır.
- Kasadan "Kodu iptal et" denince o an ölür.
- Yalnızca kodun **adına üretildiği personele** bağlanır; başka kimseye değil.

Altı haneli kod ise eskisi gibi davranır: salonun öbür ucundan okunabilecek bir
şey şifre yerine geçemez, o yüzden **o yol hâlâ kullanıcı adı ve şifre ister.**
Kamerası olmayan el terminalleri için duruyor.

## Kamera

- Android: kamera izni **isteğe bağlı** tanımlandı, kamerasız PDA'lar da
  uygulamayı kurabilir; onlarda altı haneli yol açık kalır.
- İzin verilmezse ya da kamera yoksa ekran bunu söyler ve "Kodu elle yaz"
  düğmesi çıkar.
- Karanlık salon için **el feneri** düğmesi var.
- Masa karekodu, wifi kartı gibi başka kareler okununca hata vermez — sessizce
  aramaya devam eder.

## Kasa tarafında

- Bağlı telefonlar listesi, karekod ekranının hemen altında.
- Bir telefon bağlandığı anda liste kendiliğinden tazelenir; kasadaki kişi
  "oldu mu?" diye beklemez.
- Kalan süre saniye saniye görünür.

## Kurulum notu

Bu sürüm yeni bir pakete ihtiyaç duyar: **`mobile_scanner` 7.4.1** (kamera ile
karekod okuma). Bu paket **Flutter 3.29+ / Dart 3.7+** ister; sizdeki Flutter
3.47.1 fazlasıyla yeterli. `pubspec.yaml` içindeki Dart alt sınırı da 3.7'ye
çekildi.

APK'yı derlemeden önce bir kez:

```
flutter pub get
flutter analyze
flutter build apk --release
```

iPhone için, Mac'te `bash tools/ios-izinler.sh` betiği yeniden çalıştırılmalı —
kamera izni metnini o ekliyor.
