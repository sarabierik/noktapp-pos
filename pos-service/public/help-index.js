'use strict';
/* =====================================================================
   What every screen is for - the manual, declared.
   =====================================================================

   Declared in one file, next to search-index.js and for the same reason: the
   screen somebody needs explained is by definition the one they have not got
   working, so nothing here may be scraped off a screen that has to render
   first. A help entry has to exist before the screen does.

   Each entry is one ANSWER to "what is this and what do I do here":
     page    the screen it belongs to, as the router knows it
     tab     optional: the tab inside that screen, by the key the screen's own
             tab strip uses (data-t), so F1 on an open tab answers about the
             tab and not about its host
     title   what it is called, as it is written on the screen
     lead    one sentence a person can repeat to the next shift
     steps   the two to four things people actually come here to do, in the
             order a shift does them
     notes   what surprises people - the thing support gets phoned about
     see     the neighbouring screens, when the real answer is on one of them
     alias   an address rather than a screen: its help is another entry's
             (page_kitchen, page_settings and page_admin all redirect, and a
             person who lands on one of them still presses F1)

   TWO READERS, ONE ENTRY, IN THIS ORDER. `lead` and `steps` are for the
   waiter mid-service with a guest waiting: short sentences, the thing to press.
   `notes` are for the owner: what a setting changes, what it costs, what
   cannot be undone. Putting the consequences first would mean the person in a
   hurry reads a warning instead of an instruction.

   NOTHING HERE IS INVENTED. Every note is something the code actually does -
   the refusals in src/modules/*, the guards in src/util/*, the comments those
   files carry about what went wrong before. A manual that describes a program
   that would be nicer than this one is worse than no manual: it is believed
   once, and then nothing in it is believed again.

   Plain words on purpose: no "sistem", no "modül", no "konfigürasyon". This is
   read at 20:30 by somebody with a table waiting.
   ===================================================================== */
registerHelp([

  /* ============================================================ satış */

  { page: 'tables', title: 'Masalar',
    lead: 'Salonun hâli. Boş masaya dokununca adisyon açılır, dolu masaya dokununca üstündeki hesap gelir.',
    steps: [
      'Üstteki alan adlarından bölümü seçin, sonra masaya dokunun. Boş masa doğrudan yeni adisyon açar.',
      'Dolu masaya dokununca üstündeki adisyonlar listelenir. Aynı masaya ikinci bir grup oturduysa "Yeni adisyon" deyin; iki hesap ayrı ayrı ödenir.',
      'Masası olmayan satış için "Hızlı satış": paket, gel-al ve tezgâh satışı buradan geçer.',
      'Kalabalık bir grup için "Masa birleştir": masaları seçin, sipariş tek adisyona yazılır.',
    ],
    notes: [
      'Birleştirilen masalarda hesap ana masada durur, ama üç masa da dolu görünür - çünkü üçünde de insan oturuyor. Grup, hesap ödendiğinde ya da elle dağıtıldığında biter.',
      'Gün sonu alınmış bir günde yeni adisyon açılmaz. Günü yeniden açmadan satış yapamazsınız.',
      'Üstünde açık adisyon olan masa kapatılamaz: hesap açık kalır, tile kalmaz ve ona ulaşacak hiçbir yol olmazdı. Program masanın adını ve kaç açık adisyonu olduğunu söyleyerek reddeder.',
      'Kendi açık adisyonu olan bir masa gruba katılamaz; program hangi adisyon olduğunu numarasıyla söyler. Ana masanın kendi hesabı grubun hesabı olur - ama ana masada birden fazla açık adisyon varsa hangisinin grubun hesabı olacağına önce siz karar verirsiniz.',
    ],
    see: ['order', 'duzen', 'bills'] },

  { page: 'order', title: 'Adisyon',
    lead: 'Bir masanın hesabı: ürün eklenir, mutfağa gider, indirim yapılır, ödeme alınır.',
    steps: [
      'Soldan kategori, sonra ürün. Her dokunuş bir adet ekler.',
      'Sipariş, kategorinin bağlı olduğu istasyona düşer: mutfak fişi mutfağa, bar fişi bara.',
      '"İndirim" tüm adisyona ya da tek bir satıra uygulanır. Hangi satırı seçtiğinizi listede görürsünüz ve indirim tutarı siz onaylamadan önce ekranda hesaplanır.',
      '"Öde" ile ödeme alın. Nakit, kredi kartı, yemek kartı, havale, ikram ve açık hesap ayrı ayrı kaydedilir; bir hesap birkaç yöntemle bölünebilir.',
    ],
    notes: [
      'Menü fiyatları KDV dâhildir. Fişteki KDV fiyatın içinden çıkarılır, üstüne eklenmez - 220 ₺ %10 ürün, 200 ₺ işletmenin ve 20 ₺ devletin payıdır.',
      'İndirim yapınca KDV de aynı oranda düşer. Hiç alınmamış paranın vergisi ödenmesin diye indirim önce satırlara kuruş kuruş dağıtılır, vergi ondan sonra hesaplanır.',
      'Nakitte müşterinin uzattığı tutarı yazarsınız; kasaya giren yalnızca hesabın kendisidir, para üstü kasadan çıkmış sayılır. Vardiya sayımı bu yüzden tutar.',
      'Ödenecek tutar sıfırlanınca adisyon kendiliğinden kapanır. Tamamen ikram edilen hesap da kapanır - eskiden açık kalır, masa kırmızı durur ve tek bir ikram yüzünden gün sonu alınamazdı.',
    ],
    see: ['tables', 'kasa', 'bills'] },

  /* page_kitchen returns page_mutfak: one board, two names, one answer. */
  { page: 'kitchen', alias: 'mutfak' },

  { page: 'mutfak', title: 'Ekranlar',
    lead: 'Mutfağın, barın ve tatlıcının ekranı: hangi sipariş ne zaman geldi, kim hazırlıyor, ne çıktı.',
    steps: [
      'Üstteki istasyon rozetlerinden kendi istasyonunuzu seçin. "Tümü" hepsini gösterir, rozetin üstündeki sayı bekleyen kalem sayısıdır.',
      'Bir kalem tezgâha alınınca "Hazırlanıyor", bitince "Hazır", garson alınca "Servis".',
      '"Geçmiş" sekmesi tek bir soruyu yanıtlar: o sipariş çıktı mı, çıkmadıysa ne oldu.',
    ],
    notes: [
      'Fişler beklemeye göre renklenir ve geciken kalem kırmızıya döner. Ekranda gözü çeken tek şey odur; ikinci bir renk gecikmeyi görünmez yapardı.',
      '"İstasyonsuz" rozetinde bir şey birikiyorsa hata mutfakta değil: o kategoriye istasyon atanmamıştır. Ayarlar → Yazıcı ve fiş → İstasyonlar.',
    ],
    see: ['fis', 'products', 'order'] },

  { page: 'duzen', title: 'Masa düzeni',
    lead: 'Salonun kendisi: alanlar, masalar, kaç kişilik oldukları ve masaların üstündeki karekodlar.',
    steps: [
      '"Alan ekle" ile bölüm açın (Salon, Teras, Bahçe), sonra "Masa ekle" ya da tek seferde "Toplu masa".',
      'Bir masayı düzenleyerek adını, kaç kişilik olduğunu ve hangi alanda durduğunu değiştirin.',
      'Sıralamayı odanın gerçek düzenine göre yapın: garson ekranda masayı, salonda gördüğü yerde arar.',
    ],
    notes: [
      'Masa düzeni kurulum sihirbazında bir kez sorulur ve orada bırakılırdı. Haziranda teras açan bir restoranın bunu söyleyecek yeri yoktu; kalıcı yeri burasıdır.',
      'Üstünde açık adisyon olan masa kapatılamaz. Önce hesabı kapatın - yoksa açık bir hesap, onu açacak hiçbir masa olmadan ortada kalırdı.',
    ],
    see: ['tables', 'qrmenu', 'rezervasyon'] },

  { page: 'duzen', tab: 'alan', title: 'Alanlar ve masalar',
    lead: 'Bölümler ve içlerindeki masalar. Masalar ekranındaki sekmeler bu alanlardır.',
    steps: [
      'Alan ekleyin, masaları o alana koyun, "Toplu masa" ile Masa 1-12 gibi bir seriyi tek seferde açın.',
      'Bir masayı başka alana taşımak için düzenleyip alanını değiştirin; masanın geçmişi kendisiyle birlikte gider.',
    ],
    notes: [
      'İçinde aktif masası olan alan silinmez. Program kaç masa olduğunu söyler ve önce onları başka alana taşımanızı ya da kapatmanızı ister.',
      'Kaç kişilik olduğu rezervasyonda uyarı üretir, engel değil. Masalar her akşam birleştiriliyor ve kasanın bunu bilmesine imkân yok.',
    ],
    see: ['tables', 'rezervasyon'] },

  { page: 'duzen', tab: 'qr', title: 'Karekod kartları (masa düzeninden)',
    lead: 'Masanın üstüne konacak kartın PDF\'i. Telefon karekodu okutunca o masanın dijital menüsü açılır.',
    steps: [
      'Kartlarını istediğiniz masaları seçin ve PDF alın; A5 sayfada baskıya hazır çıkar.',
      'PDF\'i matbaaya gönderin. Kart masada aylarca kalır, bu yüzden basmadan önce bir tanesini telefonla deneyin.',
    ],
    notes: [
      'Karekodun etrafındaki boşluk tasarım değil, okunma şartıdır. Çerçeveyi karekodun üstüne taşımayın; telefon o kodu okumakta zorlanır.',
      'Kart, QR menü ekranındaki adresle aynı adresi taşır. İkisi de tek bir yerden üretilir, bu yüzden farklı sayfaya çıkmaları mümkün değildir.',
    ],
    see: ['qrmenu', 'duzen'] },

  { page: 'rezervasyon', title: 'Rezervasyon',
    lead: 'Kimin, ne zaman, hangi masaya söz verildiği - ve akşam geldiğinde o rezervasyonun adisyona dönmesi.',
    steps: [
      'Tarih aralığını seçip günün rezervasyonlarını görün.',
      'Rezervasyon ekleyin: kişi, telefon, saat, kaç kişi, hangi masa.',
      'Misafir gelince rezervasyonu masaya oturtun; adisyon normal bir adisyon gibi açılır, numarası ve vardiyası yerli yerinde olur.',
    ],
    notes: [
      'Aynı masaya aynı saate ikinci bir söz vermek reddedilir - hem de "Masa 6 saat 19:00\'da Yılmaz ailesine ayrılmış" diye, kim olduğunu söyleyerek. Gerçekten iki grup uzun bir masayı paylaşacaksa yönetici bunu zorlayabilir, ama kayıt uyarıyı üstünde taşımaya devam eder.',
      'Kaç kişilik olduğu uyarı üretir, engel değil: masalar her akşam birleştiriliyor ve kasanın bunu bilmesine imkân yok.',
      'İptal edilmiş ve gelmemiş rezervasyonlar çakışma sayılmaz; o masa gerçekten boştur.',
    ],
    see: ['tables', 'guests'] },

  { page: 'bills', title: 'Adisyonlar',
    lead: 'Açık ve kapanmış hesaplar. Bir adisyonun içine bakmak, fişini yeniden yazdırmak ya da onu geri açmak için burası.',
    steps: [
      'Tarihi değiştirip "Getir" deyin. Arama kutusu masa adında, garson adında ve adisyon numarasında çalışır.',
      'Kapanmış bir satıra tıklayın: içindekiler, ödemeleri ve fişi yeniden yazdırma / e-posta düğmeleri açılır.',
      '"Geri aç" kapanmış bir adisyonu yeniden açar. Düzelttikten sonra tekrar ödeme alıp kapatırsınız.',
    ],
    notes: [
      'Günü kapatılmış bir adisyon geri açılamaz: "Gün sonu alınmış adisyon açılamaz". Önce Gün sonu ekranından o günü yeniden açın.',
      'Geri açılan adisyonun ödemesi üstünde kalır, yani ödenecek tutarı sıfırdır. Hiçbir şeyi değiştirmeden kapatmak için yine "Öde" deyin; program tutar kalmadığını görüp adisyonu kapatır.',
      'Adisyonu kayıtlardan çıkarmak bu ekranda değil, Raporlar → İşlemler\'dedir ve yalnızca işletme sahibi yapar.',
    ],
    see: ['order', 'islemler', 'gunsonu'] },

  /* ============================================================= kasa */

  { page: 'kasa', title: 'Kasa',
    lead: 'Vardiya açılır, çekmeceye para girer çıkar, gün içinde kasadaki para buradan sayılır.',
    steps: [
      'Vardiyayı açarken çekmecedeki açılış parasını yazın. Vardiya açık olmadan ödeme almayın: ödeme açık vardiyaya yazılır.',
      'Kasadan para çıkarken ya da içine koyarken sebebini yazın - "tedarikçiye ödendi", "bozukluk kondu".',
      '"Kasa sayımı" ile 200\'lük kaç tane, 100\'lük kaç tane diye sayın. Toplamı program yapar.',
      '"X raporu" vardiyanın o âna kadarki durumudur: hiçbir şeyi kapatmaz, sıfırlamaz.',
    ],
    notes: [
      'Sebepsiz kasa hareketi kabul edilmez. Sebebi olmayan bir çıkış muhasebe kaydı değil, eksik nottur - akşam kimse hatırlamaz.',
      'Çekmeceyi satış olmadan açmak kayda geçer. Bunu izlemek için değil, ortada iz kalsın diye: eskiden hiçbir iz kalmıyordu.',
      'Vardiya kapandıktan sonra rakamlar dondurulur. Bir telefondan geç gelen ödeme, kasiyerin sayıp imzaladığı çekmeceyi geriye dönük değiştiremez.',
      'Kasa sayımında 25 kuruşun altı yoktur. Restoranda kimse 10 kuruş saymaz.',
    ],
    see: ['vardiyalar', 'gunsonu', 'reports'] },

  { page: 'vardiyalar', title: 'Vardiya geçmişi',
    lead: 'Kapanmış vardiyalar ve her birinin eksiği fazlası. Bir gecelik açık bir şey söylemez, aynı kişide sekiz kez tekrarlayan açık söyler.',
    steps: [
      'Vardiyayı seçip açılış parasını, tahsilatı, beklenen ve sayılan nakdi yan yana görün.',
      'Farkı olan vardiyalara bakın: kasiyer, tarih ve tutar orada yazar.',
    ],
    notes: [
      'Kapanmış vardiyanın rakamları kaydedilmiş rakamlardır, yeniden hesaplanmaz. Bu yüzden bugün baktığınızda da, altı ay sonra baktığınızda da aynı sayıyı görürsünüz.',
      'Farkı düzeltmenin yolu yoktur ve olmaması doğrudur. Yanlış sayım varsa yeni bir kasa hareketiyle sebebini yazarak düzeltin.',
    ],
    see: ['kasa', 'gunsonu'] },

  /* ========================================================= raporlar */

  { page: 'reports', title: 'Raporlar',
    lead: 'Bugünün cirosu, Z raporu ve seçtiğiniz tarih aralığının satış dökümü.',
    steps: [
      'Üstteki dört kutu bugünü söyler: ciro, ortalama adisyon, açık adisyon (ve masadaki para), KDV.',
      '"Z raporu" günün mali özetidir; "Yazdır" ile fişten alınır.',
      'Dönem raporunda tarih aralığı ve tür seçin (günlük satış, ürün satışları, garson performansı), sonra CSV ya da PDF.',
      '"X raporu yazdır" vardiyanın o anki durumunu basar ve hiçbir şeyi kapatmaz.',
    ],
    notes: [
      'Buradaki "Gün sonu" düğmesi hem açık adisyon hem açık vardiya varken çalışmaz. Önce adisyonları kapatın, sonra vardiyayı.',
      'Kayıtlardan çıkarılmış bir adisyon hiçbir rakama girmez: ne ciroya, ne ödeme dağılımına, ne ürün sayısına. Z raporunun kendi içinde tutmasının sebebi budur.',
      'Gün, gece yarısı değil iş günü başlangıcında döner (varsayılan 06:00). Saat 02:30\'da kapanan hesap dünün raporundadır.',
    ],
    see: ['gunsonu', 'pnl', 'finans'] },

  { page: 'pnl', title: 'Kâr / Zarar',
    lead: 'Ciro eksi maliyet eksi gider. Bu programda kârın tek bir tanımı vardır ve her ekran onu okur.',
    steps: [
      'Hazır aralıklardan birine basın (Bugün, Son 7 gün, Son 30 gün) ya da iki tarih yazıp "Getir" deyin.',
      'Üstteki dört kutuyu okuyun: net kâr, KDV\'siz ciro, ürün maliyeti ve adisyon sayısı.',
      'Altındaki kategori ve ürün tablolarından hangisinin kazandırdığını görün; giderler kalem kalem ayrı listelenir.',
      'CSV ya da PDF ile dışarı alın.',
    ],
    notes: [
      'KDV kârdan önce düşülür, çünkü KDV hiçbir zaman işletmenin parası olmadı. %10 KDV\'de gerçek %22\'lik marj, eski yöntemle %30 görünürdü - ve bir yemeği pişirmeye devam edip etmeyeceğinize o rakamla karar verirsiniz.',
      'Maliyeti girilmemiş ürün burada sıfır maliyetli sayılır ve marjı olduğundan iyi görünür. Kâr rakamı, Ürünler ekranına yazılmış maliyetler kadar doğrudur.',
      'Gün, iş gününe göre sayılır. Gece 02:00\'de kapanan hesap, hâlâ çalışılan gecenin hesabıdır.',
    ],
    see: ['finans', 'reports', 'fiyat'] },

  { page: 'finans', title: 'Finans',
    lead: 'Seçilen dönemin parası: neyle tahsil edildi, ne kadar indirim ve iptal oldu, tedarikçiye ne ödendi.',
    steps: [
      'Üstteki hazır aralıklardan birine basın ya da iki tarihi yazıp "Getir" deyin.',
      '"Dönem özeti" çubuklarını okuyun: kâr, maliyet, KDV, indirim ve iptal - hepsi ciroya oranla.',
      'Ödeme yöntemi dağılımına bakın: nakit, kredi kartı, yemek kartı, havale, ikram, açık hesap.',
      'İndirim ve iptal listelerini açın; her satır kimin yaptığını ve sebebini taşır. CSV, Excel ve PDF olarak dışarı alınır.',
    ],
    notes: [
      'Buradaki her rakam Kâr / Zarar ekranıyla aynı yerden gelir. İki ekranın aynı salı gününe farklı değer vermesi mümkün değildir - eski sistemde dokuz ayrı cevap vardı.',
      'İptal oranı ciroyu aşarsa ekran bunu ayrıca söyler ve rakam kırpılmadan yazılır. Rapor dışına alınmış eski adisyonlar dar bir dönemde bunu yapabilir; sayıyı gizlemek sorunu gizlemek olurdu.',
      'Alımlar cironun %60\'ını geçtiğinde uyarı çıkar: ya stok fazlası alınmıştır ya tedarikçi zam yapmıştır.',
      'İkram da bir ödeme yöntemidir ve ciroda görünür; ödenmemiş hesap değildir.',
    ],
    see: ['pnl', 'islemler', 'stock'] },

  { page: 'gunsonu', title: 'Gün sonu',
    lead: 'Günün kapatılması: o güne kadarki hesaplar imzalanır ve dondurulur.',
    steps: [
      'Gün listesinden günü seçin, detayında ciroyu, maliyeti ve kâr rakamını görün.',
      'Kapatırken sayılan nakit ve kart tutarını yazın; program beklenen tutarla farkını gösterir.',
      'Yanlış kapattığınız bir günü "Yeniden aç" ile geri alabilirsiniz.',
    ],
    notes: [
      'Açık adisyon varken gün kapanmaz. Program kaç adisyonun açık olduğunu söyler: "3 adisyon hâlâ açık. Önce onları kapatın."',
      'Gün kapanınca sadece o gün değil, o âna kadar kapanmış bütün hesaplar kilitlenir. İmzaladığınız rakamın sonradan sessizce değişmemesi için böyledir.',
      'Yeniden açmak kaydı silmez, "yeniden açıldı" diye işaretler. Günün bir kez kapatıldığı bilgisi kalıcıdır.',
      'Gelecek bir gün kapatılamaz.',
    ],
    see: ['reports', 'islemler', 'kasa'] },

  { page: 'islemler', title: 'İşlemler',
    lead: 'Kapanmış adisyonların listesi ve onları kayıtlardan çıkaran düğmeler. Paranın defterden çıktığı yer burasıdır.',
    steps: [
      'Tarih aralığı, durum ve arama ile adisyonu bulun; satır adisyonun içini açar.',
      '"Kayıtlardan çıkar" adisyonu raporların dışına alır, ödemelerini de birlikte. Adisyon durur, sayılmaz.',
      '"Geri al" kayıtlardan çıkarılmış bir adisyonu geri koyar.',
      'Kalıcı silme, stoğu ve ödemeleri geri çevirip kaydı gerçekten yok eder; öncesinde iz bırakır.',
    ],
    notes: [
      'Bu düğmeler yalnızca işletme sahibindedir. Ekranda gizlenmiş olmaları süs değil - sunucu da reddeder, bu yüzden "gizli düğmeyi bulmak" işe yaramaz.',
      'Kapatılmış bir güne ait adisyona dokunulamaz: "Bu adisyon kapatılmış bir güne ait, silinemez veya geri alınamaz. Önce ilgili günü yeniden açın."',
      'Her işlem, kim yaptı ve öncesinde ne yazıyordu bilgisiyle günlüğe geçer. Eski sistemde hiçbir iz kalmazdı; tek kanıt raporda eksilen paraydı.',
    ],
    see: ['gunsonu', 'gunluk', 'bills'] },

  /* ============================================================= menü */

  { page: 'products', title: 'Ürünler',
    lead: 'Menünün kendisi: kategoriler, ürünler, fiyatlar, KDV oranları ve maliyetler.',
    steps: [
      'Arama kutusuna ürün ya da kategori adı yazın; liste kategoriye göre gruplanmış gelir.',
      'Ürüne tıklayın, kartı açılsın: fiyat geçmişi, maliyet geçmişi ve marj orada.',
      '"Düzenle" ile fiyatı, maliyeti, KDV oranını ve ürünün kasada / QR menüde görünüp görünmeyeceğini değiştirin.',
      'Yüzlerce ürün için "İçe / dışa aktar": listeyi Excel\'e alın, orada düzenleyin, geri yükleyin.',
    ],
    notes: [
      'Fiyat KDV dâhil yazılır. Ürüne %10 yazdığınızda 220 ₺\'nin içinden 20 ₺ vergi çıkar; 220\'nin üstüne eklenmez.',
      'Maliyet alanı boşsa kâr raporu o ürünü sıfır maliyetli sayar ve marjı olduğundan iyi gösterir. Kâr rakamının doğruluğu bu alan kadardır.',
      'Dışa aktarılan dosyada her satırın ID\'si vardır. ID\'li satır günceller, ID\'siz satır yeni ürün açar - bu yüzden ID sütununu silmeyin, yoksa menüniz ikiye katlanır.',
      'İçe aktarma önce önizlenir. Menü, bütün kasanın üstünde durduğu şeydir; kontrol edilmemiş bir tabloyla ezilmesi cuma sabahı yanlış fiyatla açmak demektir.',
      '"Kasada göster" kapalı bir ürün menüden silinmiş değildir, sadece kasada görünmez. Silmek yerine bunu kullanın: geçen yılın adisyonları hâlâ o ürünü gösteriyor.',
    ],
    see: ['fiyat', 'stock', 'para'] },

  { page: 'fiyat', title: 'Fiyatlandırma',
    lead: 'Menüyü marj gözüyle tarar ve hangi fiyatın ne olması gerektiğini hesabıyla birlikte söyler.',
    steps: [
      '"Menüyü tara" deyin; her ürünün maliyeti, KDV\'siz net fiyatı ve marjı çıkar.',
      '"Öneriler" sekmesinde hedefin altında kalan ürünleri görün ve öneriyi kabul edin - kabul etmek fiyatı gerçekten değiştirir.',
      'Toplu zam için "Toplu fiyat", kategori bazında hedef koymak için "Hedef marj".',
    ],
    notes: [
      'Hesap ekranda yazar ve tartışılabilir: net = fiyat ÷ (1 + KDV), marj = (net − maliyet) ÷ net. KDV her zaman önce çıkar.',
      'Maliyet üç ayrı yerden gelebilir ve hangisinin kullanıldığı satırda yazar. Ürün kartına elle yazılmış maliyet ile satış anındaki gerçek maliyet aynı şey değildir.',
      'Eski sistemde "kabul et" düğmesi hiçbir fiyatı değiştirmezdi; kusursuz kullansanız bile tek bir fiyat yükseltemezdiniz. Burada kabul etmek fiyatı yazar ve geçmişe kaydeder.',
    ],
    see: ['products', 'pnl', 'stock'] },

  { page: 'fiyat', tab: 'oneri', title: 'Öneriler',
    lead: 'Hedef marjın altında kalan ürünler ve her biri için önerilen fiyat.',
    steps: [
      'Listeyi marja göre okuyun; en kötü ürün üstte.',
      'Öneriyi kabul edin - fiyat değişir ve fiyat geçmişine yazılır.',
    ],
    notes: [
      'Öneri bir yüzde bandı değil, hesaptır: hedef net = maliyet ÷ (1 − hedef marj), sonra KDV eklenip yukarı yuvarlanır.',
      'Maliyeti girilmemiş ürün için öneri üretilemez. Boş maliyet, sonsuz marj demektir.',
    ],
    see: ['fiyat', 'products'] },

  { page: 'fiyat', tab: 'hedef', title: 'Hedef marj',
    lead: 'Hangi kategorinin yüzde kaç kazanması gerektiği. Bütün öneriler bu sayıdan çıkar.',
    steps: [
      'Kategori başına hedef yüzdeyi yazın ve kaydedin.',
      'Sonra "Menüyü tara" deyin: hedefin altında kalanlar öne çıkar.',
    ],
    notes: [
      'Hedef, KDV\'siz net fiyat üstünden ölçülür. Menü fiyatı üstünden düşünürseniz KDV oranı kadar iyimser bir hedef koymuş olursunuz.',
      'İçecekle ana yemeğin hedefi aynı olmaz. Tek bir yüzdeyi bütün menüye vermek, karışık bir menüde her ürünü yanlış fiyatlar.',
    ],
    see: ['fiyat', 'pnl'] },

  { page: 'fiyat', tab: 'toplu', title: 'Toplu fiyat',
    lead: 'Bir kategorinin ya da bütün menünün fiyatını tek seferde yüzdeyle değiştirmek.',
    steps: [
      'Kategoriyi ve yüzdeyi seçin, sonucu listede görün, sonra uygulayın.',
      'Yuvarlama adımını seçin: 254,30 ₺ diye menü yazılmaz.',
    ],
    notes: [
      'Uygulamadan önce yeni fiyatlar listelenir. Bu ekran menünün tamamını değiştirebilir, o yüzden onaydan önce gösterir.',
      'Her değişiklik ürünün fiyat geçmişine ayrı ayrı yazılır; zammı geri almak isterseniz eski fiyat orada durur.',
    ],
    see: ['fiyat', 'products'] },

  { page: 'fiyat', tab: 'icgoru', title: 'İçgörüler',
    lead: 'Hangi zam gerçekten para getirir, hangi ürünün marjı hiç bilinmiyor.',
    steps: [
      '"En büyük kazanç" listesine bakın: zammı yüzdeye göre değil, paraya göre sıralar.',
      '"Hedefin altındakiler" listesinden hangi ürünün ne kadar geride kaldığını görün.',
      '"Maliyeti girilmemiş ürünler" listesini bitirin - her satırın yanında maliyet girme düğmesi vardır.',
    ],
    notes: [
      'Sıralama paraya göredir çünkü kimsenin sipariş etmediği bir üründeki %40 zam, her gün satılan bir üründeki %5\'ten az kazandırır.',
      'Maliyeti bilinmeyen ürün %100 marjlı değildir, marjı bilinmiyordur. Bu ürünler ortalamaya ve önerilere hiç girmez; ayrı listelenmelerinin sebebi budur.',
    ],
    see: ['fiyat', 'pnl', 'products'] },

  { page: 'fiyat', tab: 'karar', title: 'Kararlar',
    lead: 'Uygulanan ve reddedilen fiyat önerilerinin geçmişi: hangi ürün, eski ve yeni fiyat, kim, ne zaman.',
    steps: [
      'Uygulananlar listesinden bir zammın ne zaman ve kim tarafından yapıldığını bulun.',
      'Reddedilenler listesinde reddetme sebebi de yazar; aynı öneri tekrar geldiğinde niye geçilmiş olduğunu okuyun.',
    ],
    notes: [
      'Buradaki kayıt kararın kendisidir. Fiyatın tam geçmişi ürünün kartındadır ve elle yazılan fiyatları da içerir.',
      'Her satırda maliyetin nereden geldiği de yazar. Tahmini bir maliyetle alınmış karar, ölçülmüş bir maliyetle alınmış karardan farklıdır.',
    ],
    see: ['fiyat', 'products'] },

  /* ============================================================= stok */

  { page: 'stock', title: 'Stok',
    lead: 'Depo: malzemeler, alış faturaları, reçeteler, sayım, zayi ve şubeler arası transfer.',
    steps: [
      'Mal geldiğinde "Alış faturası" girin; stok o faturayla artar.',
      'Reçeteler sekmesinde ürünün neyden yapıldığını yazın - satılan lahmacun un ve kıymayı ancak reçetesi varsa düşer.',
      'Ayda bir "Sayım": saydığınızı yazın, fark listelensin.',
      'Bozulan, düşen, yanlış hazırlanan için "Zayi" - sebebiyle birlikte.',
    ],
    notes: [
      'Reçetesi olmayan ürün satıldığında hiçbir malzeme düşmez. Eski sistemde pide satmak bir gram un eksiltmezdi; bu, düzeltilmiş hâlidir ama reçeteyi yazmak size kalmıştır.',
      'Stok her seferinde hareketlerden yeniden hesaplanır; ayrıca tutulan bir "kalan" sayısı yoktur. Bu yüzden iki ekran farklı kalan gösteremez.',
      'Taslak alış faturası hiçbir şeyi hareket ettirmez. Onaylanana kadar stok artmaz - eskiden onay tamamen süstü, taslak stoğu çoktan yazmış olurdu.',
      'Zayi sebebi serbest metin değil, listedir. "Bozuldu", "düşürüldü" ve "yanlış hazırlandı" üç ayrı işletme sorunudur; tek bir zayi toplamı hiçbirini söylemez.',
    ],
    see: ['products', 'pnl', 'fiyat'] },

  { page: 'stock', tab: 'genel', title: 'Stok - Genel',
    lead: 'Deponun dört rakamı ve azalmakta olan malzemelerin listesi.',
    steps: [
      'Kritik seviyeye düşen malzemelere bakın; sipariş listeniz odur.',
      '"Onay bekleyen fatura" sıfırdan büyükse mal gelmiş ama stoğa girmemiştir.',
      'Bir malzemenin "Hareketler" düğmesiyle o miktarın nereden geldiğini adım adım izleyin.',
    ],
    notes: [
      'Buradaki her sayı hareketlerden hesaplanır. Yanlış görünen bir kalan, yanlış bir sayı değil, eksik ya da fazla girilmiş bir harekettir - "Hareketler" onu gösterir.',
      'Eski sistemde silinmiş malzemelere ait hareketler varsa ayrıca uyarılır: miktar defterde durur ama bağlı olduğu malzeme kaydı yoktur.',
      'Stok değeri kilo, şişe ve litreyi toplamaz; para olarak toplar. Eski panodaki "toplam miktar" hiçbir şey ifade etmiyordu.',
    ],
    see: ['stock', 'products'] },

  { page: 'stock', tab: 'seviye', title: 'Stok durumu',
    lead: 'Her malzemeden elde ne kadar var, kritik seviyesi ne.',
    steps: [
      'Malzemeyi arayın, kalan miktarı ve birimini görün.',
      'Kritik seviyeyi malzeme tanımından ayarlayın; liste ona göre uyarır.',
    ],
    notes: [
      'Eksi görünen stok bir hata değil, bir bilgidir: satılmış ama girişi yapılmamış mal. Genellikle eksik bir alış faturası anlamına gelir.',
      'Birim, malzemenin tanımındaki birimdir. Kilo alıp gram reçete yazarsanız iki ekran birbirini tutmaz.',
    ],
    see: ['stock', 'stock:alis'] },

  { page: 'stock', tab: 'alis', title: 'Alış faturaları',
    lead: 'Tedarikçiden gelen mal: fatura, kalemler, miktarlar ve birim fiyatlar.',
    steps: [
      'Yeni fatura açın, tedarikçiyi seçin, kalemleri girin.',
      'Kontrol edin ve onaylayın. Stok, onayla birlikte artar.',
    ],
    notes: [
      'Taslak fatura stoğa hiçbir şey eklemez. Onay gerçek bir adımdır, formalite değil.',
      'Girdiğiniz birim fiyat malzemenin maliyetini günceller, o da reçete üstünden ürünün maliyetine ve oradan kâr raporuna gider. Yanlış girilen bir fatura fiyatı bütün marjları bozar.',
    ],
    see: ['stock', 'pnl'] },

  { page: 'stock', tab: 'recete', title: 'Reçeteler',
    lead: 'Bir ürünün neyden, ne kadarından yapıldığı. Satışın stoğu düşürmesini sağlayan tek bağlantı budur.',
    steps: [
      'Ürünü seçin, malzemelerini ve gramajlarını yazın.',
      'Kaydedin. O andan sonra satılan her porsiyon malzemeleri düşer.',
    ],
    notes: [
      'Reçete yoksa satış stoğu hiç etkilemez. Stok tutmuyor diye şikâyet edilen ürünlerin çoğunun reçetesi yoktur.',
      'Reçete geçmişe dönük çalışmaz: dün satılanı düşürmez, bugünden itibaren düşürür.',
      'Gramajı doğru yazmak maliyetin de doğru olması demektir; reçete aynı zamanda ürünün maliyetini besler.',
    ],
    see: ['stock', 'products', 'fiyat'] },

  { page: 'stock', tab: 'sayim', title: 'Sayım',
    lead: 'Depoda gerçekten ne olduğunu yazıp programın bildiğiyle karşılaştırmak.',
    steps: [
      'Sayımı açın, malzemeleri tek tek sayıp yazın.',
      'Fark listesine bakın, sonra sayımı uygulayın: stok saydığınız değere çekilir.',
    ],
    notes: [
      'Sayım uygulanana kadar hiçbir şey değişmez. Yarım kalmış bir sayıma geri dönebilirsiniz; ekran sekmeyi hatırlar.',
      'Büyük bir fark neredeyse her zaman eksik reçete ya da girilmemiş zayidir; sayım o farkı kapatır ama sebebini ortadan kaldırmaz.',
    ],
    see: ['stock', 'stock:zayi'] },

  { page: 'stock', tab: 'zayi', title: 'Zayi',
    lead: 'Bozulan, düşen, yanlış hazırlanan mal - sebebiyle birlikte stoktan düşer.',
    steps: [
      'Malzemeyi, miktarı ve sebebi seçin: bozuldu, kırıldı, mutfak hatası, kayıp, personel yemeği, diğer.',
      'Kaydedin; stok düşer ve kayıt zayi raporuna geçer.',
    ],
    notes: [
      'Sebep listeden seçilir, serbest yazılmaz. "Bozuldu" ile "mutfak hatası" iki ayrı işletme sorunudur ve tek bir zayi toplamı hangisi olduğunu söylemez.',
      'Personel yemeği de zayi olarak girilir - ücretsiz değildir, sadece satılmamıştır. Yazmazsanız fark sayımda karşınıza çıkar ve sebebi bilinmez.',
      'Zayi kâr raporuna maliyet olarak girer. Yazmamak stoğu değil, kârı yanlış gösterir.',
    ],
    see: ['stock', 'pnl'] },

  { page: 'stock', tab: 'transfer', title: 'Depo transferi',
    lead: 'Malzemenin bir depodan diğerine gitmesi - mutfak deposundan bara, ana depodan şubeye.',
    steps: [
      'Önce depolarınızı tanımlayın: "Depo ekle".',
      '"Transfer yap" ile çıkış deposunu, varış deposunu, malzemeyi ve miktarı seçin.',
      'Transfer geçmişinden ne zaman, neyin, nereden nereye, kim tarafından taşındığını görün.',
    ],
    notes: [
      'En az iki depo tanımlanmadan transfer düğmesi çalışmaz - tek deposu olan bir işletmede transfer diye bir şey yoktur.',
      'Transfer zayi değildir ve maliyet yaratmaz; mal hâlâ işletmenindir, sadece yer değiştirmiştir. Kâr raporuna hiç girmez.',
    ],
    see: ['stock', 'stock:tanim'] },

  { page: 'stock', tab: 'tanim', title: 'Malzeme ve tedarikçi',
    lead: 'Malzemelerin kendisi (adı, birimi, kritik seviyesi) ve maldan aldığınız firmalar.',
    steps: [
      'Malzeme ekleyin: ad, birim (adet, kg, gram, litre, ml, paket) ve kritik seviye.',
      'Tedarikçi ekleyin; alış faturasında bu listeden seçeceksiniz.',
    ],
    notes: [
      'Birim sonradan değiştirilirse eski hareketler eski birimde kalır. Kilo mu gram mı olacağına başlarken karar verin.',
      'Kullanılmış bir malzeme silinmez, pasife alınır: geçmiş faturalar ve reçeteler ona bakıyor.',
    ],
    see: ['stock', 'stock:alis'] },

  /* ========================================================== müşteri */

  { page: 'guests', title: 'Müşteri',
    lead: 'Restoranın tanıdığı kişiler ve rezervasyonları.',
    steps: [
      'Ada ya da telefona göre arayın.',
      '"Müşteri ekle" ile yeni kayıt açın; adisyona bağlamak istediğinizde telefon numarası yeterlidir.',
      'Sağdaki listeden rezervasyon ekleyin ya da bugünküleri görün.',
    ],
    notes: [
      'Müşteri kaydı bu programda değil, ortak bir kayıt defterinde tutulur: Pass uygulamasına kendi kaydolan bir misafir kasada da tanınır.',
      'Yeni bir müşteriyi ilk kez kaydetmek için internet gerekir. Kayıtlı müşteri, internet olmadan da telefon numarasıyla bulunur.',
    ],
    see: ['musteri', 'sadakat', 'rezervasyon'] },

  { page: 'musteri', title: 'Müşteri kartı',
    lead: 'Tek bir misafirin kartı: ne sıklıkla geliyor, ne harcıyor, elinde ne var.',
    steps: [
      'Misafiri arayın; geçmiş adisyonları, toplam harcaması ve son gelişi listelenir.',
      '"Açık adisyona ekle" ile misafiri masadaki hesaba bağlayın.',
    ],
    notes: [
      'Misafiri adisyona bağlamak sadece kayıt tutmak değildir: sadakat damgası, hesap kapandığında bağlı misafire yazılır. Bağlamazsanız damga da yoktur.',
      'Harcama toplamı yalnızca kapanmış ve kayıtlarda duran adisyonları sayar.',
    ],
    see: ['guests', 'sadakat', 'bills'] },

  { page: 'sadakat', title: 'Sadakat',
    lead: 'Damga kartları: kaç alışta bir ne veriliyor, kimin kaç damgası var ve işletmenin ne kadar borcu birikti.',
    steps: [
      'Programlar sekmesinde kart açın: hangi ürün, kaç adet, ödülü ne.',
      'Kartlar sekmesinde misafirlerin ilerlemesini görün.',
      'Rapor sekmesinde açık yükümlülüğe bakın: kazanılmış ama henüz alınmamış ödüller.',
    ],
    notes: [
      'Damga adet başınadır, fiş başına değil. Bir seferde üç kahve alan misafir üç damga alır.',
      'Damga hedefi geçtiği anda ödül basılır ve fazlası bir sonraki karta devreder; sıfırlanmaz.',
      'Bir adisyon iki kez damgalanmaz, hangi yoldan gelirse gelsin.',
      'Ödül kullanmak hesaptan gerçek para düşer. Sonradan ürün eklenip çıkarılması ödülü geri getirmez.',
      'Açık yükümlülük, parası alınmış ama henüz verilmemiş yemektir. Bilanço kalemidir, süs değil.',
    ],
    see: ['musteri', 'guests', 'qrmenu'] },

  { page: 'sadakat', tab: 'programlar', title: 'Sadakat programları',
    lead: 'Kartın kuralı: hangi üründen kaç adet alınınca ne veriliyor.',
    steps: [
      'Program ekleyin: ürün, hedef adet, ödül metni.',
      'Kullanımdaki bir programı düzenleyin ya da pasife alın.',
    ],
    notes: [
      'Hedefi düşürmek, hedefi çoktan geçmiş kartlara ödül üretmez; kural bundan sonrası için geçerlidir.',
      'Programı kapatmak elde birikmiş ödülleri silmez. Verilmeyi bekleyen ödüller açık yükümlülük olarak durur.',
    ],
    see: ['sadakat'] },

  { page: 'sadakat', tab: 'kartlar', title: 'Sadakat kartları',
    lead: 'Kim hangi programda kaçıncı damgada, elinde kaç ödül var.',
    steps: [
      'Misafiri arayın, ilerlemesini ve bekleyen ödüllerini görün.',
      'Kasada ödül kullanılacaksa adisyon ekranından yapılır, buradan değil.',
    ],
    notes: [
      'İki kasa aynı ödülü aynı anda kullanamaz; ödül tek seferde harcanır, ikinci deneme boşa gider.',
    ],
    see: ['sadakat', 'musteri'] },

  { page: 'sadakat', tab: 'rapor', title: 'Sadakat raporu',
    lead: 'Verilen damga, kullanılan ödül ve en önemlisi açık yükümlülük.',
    steps: [
      'Tarih aralığını seçin.',
      'Açık yükümlülük satırına bakın: kazanılmış, henüz alınmamış ödüllerin karşılığı.',
    ],
    notes: [
      'Açık yükümlülük bir gider tahmini değil, verilmiş sözdür. Parası alınmış yemek olarak durur.',
      'Eski sistemde bu sayıyı üreten hiçbir ekran yoktu; işletme göremediği bir borcu taşıyordu.',
    ],
    see: ['sadakat', 'pnl'] },

  { page: 'qrmenu', title: 'QR menü',
    lead: 'Masadaki karekodun açtığı dijital menü: nasıl göründüğü, neyin göründüğü ve kartların basılması.',
    steps: [
      'Görünüm sekmesinde işletme adını, karşılama yazısını ve logoyu ayarlayın.',
      'Menüde ne var sekmesinde hangi ürünlerin misafire gösterileceğini seçin.',
      'Masa kartları sekmesinden PDF alıp bastırın.',
    ],
    notes: [
      'Yayınlama diye bir adım yoktur. Menü bu bilgisayardan, kasanın kullandığı aynı veriden servis edilir: 11:00\'de değiştirdiğiniz fiyat 11:00\'de masadadır.',
      'Sağdaki telefon çerçevesinde gördüğünüz şey sayfanın çizimi değil, sayfanın kendisidir. Önizleme yanılamaz.',
      'Ürünün QR menüde görünmesi ayrı bir işarettir; kasada görünmesiyle aynı şey değildir.',
    ],
    see: ['products', 'duzen', 'guests'] },

  { page: 'qrmenu', tab: 'ayar', title: 'QR menü - Görünüm',
    lead: 'Misafirin menüyü açtığında gördüğü isim, karşılama yazısı ve logo.',
    steps: [
      'İşletme adını ve karşılama cümlesini yazın.',
      'Logoyu yükleyin ve sağdaki telefonda kontrol edin.',
    ],
    notes: [
      'Bu yazılar fişteki başlık ve alt yazıdan ayrıdır. Fiş metinleri Ayarlar → İşletme\'dedir.',
    ],
    see: ['qrmenu', 'isletme'] },

  { page: 'qrmenu', tab: 'tasarim', title: 'QR menü - Tasarım',
    lead: 'Menünün rengi ve şablonu.',
    steps: [
      'Şablonu seçin, rengi ayarlayın, telefonda görün.',
    ],
    notes: [
      'Tasarım yalnızca misafirin gördüğü sayfayı değiştirir; kasa ekranı bundan etkilenmez.',
    ],
    see: ['qrmenu'] },

  { page: 'qrmenu', tab: 'urun', title: 'QR menüde ne var',
    lead: 'Hangi kategorilerin ve ürünlerin misafire gösterileceği.',
    steps: [
      'Göstermek istemediğiniz ürünlerin işaretini kaldırın.',
      'Fiyatı olmayan ya da sadece personel için olan kalemleri kapatın.',
    ],
    notes: [
      'Buradan kapattığınız ürün kasada durmaya devam eder. İki liste ayrıdır ve öyle olması gerekir: personel yemeği menüde olmaz, kasada olur.',
    ],
    see: ['qrmenu', 'products'] },

  { page: 'qrmenu', tab: 'kart', title: 'QR menü - Masa kartları',
    lead: 'Masaların üstüne konacak karekod kartlarının A5 PDF\'i.',
    steps: [
      'Masaları seçip PDF alın ve bastırın.',
      'Basmadan önce bir kartı telefonla okutup deneyin.',
    ],
    notes: [
      'Karekodun etrafındaki beyaz boşluk okunabilirlik şartıdır; kod kendi çerçevesine değecek kadar büyütülürse telefonlar okumakta zorlanır.',
      'Kart 40 cm mesafeden, masa üstünde okunacak boyda basılır. Daha küçüğü misafiri öne eğilmeye zorlar ve öne eğilinen menü sorulmaz, garsona sorulur.',
    ],
    see: ['qrmenu', 'duzen'] },

  { page: 'qrmenu', tab: 'adres', title: 'QR menü - Masa adresleri',
    lead: 'Her masanın karekodunun açtığı adres.',
    steps: [
      'Adresleri kontrol edin; kartlardaki karekod bu adresleri taşır.',
      'Kasanın ağdaki adresi değiştiyse burada görürsünüz.',
    ],
    notes: [
      'Adresi üreten tek bir yer vardır, bu yüzden bu ekrandan basılan kartla masa düzeninden basılan kart aynı sayfayı açar.',
      'Kasanın IP adresi değişirse basılmış kartlar boşa düşer. Kasaya sabit bir adres verin.',
    ],
    see: ['qrmenu', 'cihazlar'] },

  /* ============================================================= para */

  { page: 'doviz', title: 'Döviz kurları',
    lead: 'Kasanın bugün kabul ettiği euro, dolar ve sterlin kuru.',
    steps: [
      'Her satıra bugünkü kuru yazın ve o satırın "Kaydet" düğmesine basın.',
      'Altındaki geçmişten kuru en son kimin, ne zaman, hangi değerden değiştirdiğini görün.',
      'Kullanmadığınız para birimini kapatın; kapalı olan fişe de düşmez.',
    ],
    notes: [
      'Kur yarıdan fazla değişiyorsa program bir kez daha sorar. 4,35 yerine 43,5 yazmak, biri fark edene kadar her fişe yanlış karşılık basar.',
      'Dünden kalan kur "bayat" diye işaretlenir. Eski ekranda kurun yaşı hiç yazmıyordu ve kasiyerler gün boyu dünkü kuru söylüyordu.',
      'Kur yalnızca fişteki bilgi satırıdır. Ödenecek tutar her zaman Türk lirasıdır; döviz satırı turist masası için nezakettir, hesabı değiştirmez.',
      'Kur bu programda tek bir yerde tutulur. Fiş, ekran ve rapor aynı kurdan okur, bu yüzden farklı euro göstermeleri mümkün değildir.',
    ],
    see: ['para', 'fis'] },

  { page: 'para', title: 'Para ve KDV',
    lead: 'Kasanın hangi para biriminde saydığı, kuruşun nasıl yuvarlandığı ve KDV oranlarının nereden geldiği.',
    steps: [
      'Para birimini, simgesini ve simgenin sayının önünde mi arkasında mı duracağını seçin.',
      'Kuruş hanesini ve nakit yuvarlamayı ayarlayın.',
      'KDV kartına bakın: menüde hangi oranların kullanıldığını gösterir.',
    ],
    notes: [
      'KDV kartı bilerek okunur-yazılamaz. Bir ürünün KDV oranı ürünün kendisinde durur; burada ikinci bir kutu olsaydı aynı soruya iki cevap olurdu ve hangisinin kazandığı en son kaydedene bağlı kalırdı.',
      'KDV fiyatın içindedir. Oranı değiştirmek fiyatı yükseltmez, fiyatın içindeki verginin payını değiştirir.',
      'Para birimi ayarları eskiden üç ayrı ekranda çizilirdi ve en son kaydedilen kazanırdı. Artık tek yer burasıdır; İşletme ekranı bunları çizmez ve nereye gittiklerini yazar.',
    ],
    see: ['doviz', 'products', 'isletme'] },

  /* ========================================================== ayarlar */

  { page: 'isletme', title: 'İşletme',
    lead: 'Fişte ve raporlarda görünen işletme bilgileri, çalışma saatleri ve programın genel ayarları.',
    steps: [
      'İşletme bilgileri sekmesinde unvanı, vergi numarasını, adresi ve telefonu doldurun - fişin başına bunlar basılır.',
      'İş gününün kaçta başlayacağını ayarlayın.',
      'Genel ayarlar sekmesinde ödeme, mutfak, güvenlik, e-posta ve ağ ayarları vardır.',
    ],
    notes: [
      'İş günü gece yarısı dönmez, sizin yazdığınız saatte döner (varsayılan 06:00). Gece 02:30\'da açılan hesap dünün hesabıdır - Z raporu, kâr raporu ve gün sonu hepsi bunu böyle sayar.',
      'Para birimi, kuruş yuvarlama ve KDV bu ekranda çizilmez; Para bölümüne taşındılar. Ekran bunu gizlemez, nereye gittiklerini yazar.',
      'Fiş genişliği gibi bazı ayarlar Yazıcı ve fiş ekranına aittir. Bir ayarın iki kutusu olması, iki farklı cevap demektir.',
    ],
    see: ['para', 'fis', 'kullanici'] },

  { page: 'isletme', tab: 'bilgi', title: 'İşletme bilgileri',
    lead: 'Unvan, vergi dairesi, vergi numarası, adres, telefon ve çalışma saatleri.',
    steps: [
      'Fişin başında görünmesini istediğiniz bilgileri doldurun.',
      'Haftanın günleri için açılış ve kapanış saatlerini yazın; kapalı gün için "kapalı" yazın.',
      'İş günü başlangıç saatini ayarlayın.',
    ],
    notes: [
      'İş günü saatini değiştirmek geçmiş hesapları taşımaz, bundan sonrasını etkiler. Gece yarısına yakın bir saat seçmek gece çalışan bir mekânda ciroyu iki güne böler.',
      'Hesap fişinin hangi istasyondan çıkacağı da buradadır. Yanlış istasyon, hesabın mutfaktan çıkması demektir.',
    ],
    see: ['isletme', 'fis'] },

  { page: 'isletme', tab: 'genel', title: 'Genel ayarlar',
    lead: 'Ödeme, mutfak, güvenlik, yedekleme, e-posta ve ağ ayarlarının tamamı, gruplanmış hâlde.',
    steps: [
      'Değiştirmek istediğiniz grubu açın, alanı düzenleyin, kaydedin.',
      'İndirim sınırı ve yönetici onayı gereken işlemler "Güvenlik" grubundadır.',
      'PIN uzunluğu, hatalı PIN sonrası kilit süresi ve ekran kilidi de aynı gruptadır.',
    ],
    notes: [
      'Bu liste programın kendi ayar listesinden çizilir, elle yazılmaz - yeni bir ayar eklendiği gün burada görünür.',
      'Başka bir ekranın sahiplendiği ayarlar burada çizilmez ve nereye gittikleri yazılır. Ortadan sessizce kaybolan bir ayar, destek telefonu demektir.',
      'ÖKC ile ödemeyi buradan kapatabilirsiniz; cihaz tanımlı olsa bile kasa ondan ödeme istemez.',
    ],
    see: ['isletme', 'para', 'okc'] },

  { page: 'kullanici', title: 'Kullanıcılar',
    lead: 'Kimlerin kasayı açabildiği, hangi yetkilerinin olduğu ve PIN\'lerinin sıfırlanması.',
    steps: [
      'Personel ekleyin: ad, kullanıcı adı, rol ve kasa PIN\'i.',
      'Yetkileri kişi bazında işaretleyin; rol bir başlangıç noktasıdır, son söz değil.',
      'PIN unutulduğunda ya da hesap kilitlendiğinde buradan sıfırlayın.',
    ],
    notes: [
      'Ayrılan personeli silmeyin, pasife alın. Onun açtığı geçen ayın adisyonları hâlâ o kişiyi gösteriyor.',
      'İşletme sahibinin yetkileri kapatılamaz; onay kutuları kapalıdır. Kendi yetkisini kaldıran bir sahip, kendini programın dışında bırakırdı.',
      'Yetkiyi ekrandan gizlemek güvenlik değildir - sunucu da reddeder. Gizleme sadece kimsenin çalışmayacak bir düğmeye basmaması içindir.',
    ],
    see: ['profil', 'gunluk', 'isletme'] },

  { page: 'fis', title: 'Yazıcı ve fiş',
    lead: 'Fişte ne yazdığı, hangi yazıcının nereye bastığı, istasyonlar ve müşteri ekranı - hepsi bir arada.',
    steps: [
      'Fiş ayarları sekmesinde başlık, alt yazı, kâğıt genişliği ve kopya sayısını ayarlayın; sağdaki önizleme gerçek kâğıt genişliğinde çizilir.',
      'Yazıcılar sekmesinde yazıcı ekleyin, kasa yazıcısını işaretleyin, test baskısı alın ve kuyruğu izleyin.',
      'İstasyonlar sekmesinde hangi kategorinin hangi istasyona düşeceğini söyleyin.',
      'Müşteri ekranı sekmesinde ikinci ekranda görünecek karşılama yazısını ve görseli ayarlayın.',
    ],
    notes: [
      '"Mutfağa fiş çıkmıyor" sorusunun cevabı neredeyse her zaman iki sekme arasındadır: istasyonu olmayan kategori ya da yazıcıya çalıştığını söyleyip yazıcısı olmayan istasyon. İkisi aynı hatanın iki yüzüdür, bu yüzden yan yana dururlar.',
      'Önizleme burada çizilmez: sunucu yazıcıya gidecek gerçek baskıyı üretir ve satırlarını geri gönderir. Ekranda gördüğünüz, kâğıttan çıkacak olandır. 80 mm\'de 48, 58 mm\'de 32 karakter.',
      'Yazıcı üç ayrı ekranda tanımlanabiliyordu ve biri diğerinden habersizdi. Artık tek yer burasıdır.',
      'Fiş başlığı ve alt yazısı İşletme ekranından gelir; burada ikinci bir kopyası yoktur.',
    ],
    see: ['isletme', 'mutfak', 'okc'] },

  { page: 'fis', tab: 'fis', title: 'Fiş ayarları',
    lead: 'Termal fişte ne yazacağı: başlık, alt yazı, KDV dökümü, garson, masa, karekod ve döviz satırı.',
    steps: [
      'Kâğıt genişliğini seçin (80 mm ya da 58 mm) ve kopya sayısını yazın.',
      'Fişte görünmesini istediklerinizi işaretleyin, sağdaki önizlemeden kontrol edin.',
      'Turist masaları için döviz satırını açıp hangi para birimlerinin basılacağını seçin.',
    ],
    notes: [
      'Fişteki döviz satırı bilgi içindir; ödenecek tutar Türk lirası olarak kalır.',
      'Fişe basılacak kur, Para → Döviz kurları ekranındaki kurdur. İkinci bir kur saklanmaz, böylece fiş ile ekran farklı euro gösteremez.',
      'Fiş başlığı ve alt yazısı burada değil, İşletme ekranındadır - fişi basan kod zaten oradan okuyor.',
    ],
    see: ['fis', 'doviz', 'isletme'] },

  { page: 'fis', tab: 'yazici', title: 'Yazıcılar',
    lead: 'Her yazıcının adı, adresi, kâğıt genişliği ve bekleyen baskı kuyruğu.',
    steps: [
      'Yazıcı ekleyin: ağ yazıcısı için IP adresi (çoğu termal yazıcı 9100 portunu kullanır), USB için Windows\'taki yazıcı adı.',
      'Kasa yazıcısını işaretleyin - hesap fişi oradan çıkar.',
      '"Test baskısı" ile deneyin. Çıkmıyorsa kuyruğa bakın: hata mesajı orada yazar.',
    ],
    notes: [
      'Kuyruk bekleyen baskıları tutar. "Basmıyor" şikâyetinin çoğu, ulaşılamayan bir IP yüzünden kuyrukta bekleyen işlerdir; kuyruk boşsa sorun yazıcıda değil, istasyon eşleşmesindedir.',
      'Yazıcı silmek istasyonu silmez. İstasyonu yazıcısız kalan siparişler basılmaz ve mutfak ekranında birikir.',
      'Çekmece, istasyonu olmayan bir baskı işi olarak kasa yazıcısına gider. Çekmecenin bağlı olduğu yazıcı "kasa yazıcısı" işaretli değilse "Çekmeceyi aç" yanlış makinede tıklar.',
    ],
    see: ['fis', 'mutfak'] },

  { page: 'fis', tab: 'istasyon', title: 'İstasyonlar',
    lead: 'Siparişin nereye gittiği: mutfak, bar, pide, tatlı - hangi kategorinin hangisine düştüğü ve her birinin ekrana mı yazıcıya mı çalıştığı.',
    steps: [
      'İstasyon ekleyin. Yeni istasyon "Ekrana" olarak açılır: siparişleri Ekranlar panosunda görünür ve yazıcı gerekmez.',
      'Kategorileri istasyonlara dağıtın: içecekler bara, ana yemekler mutfağa.',
      'Kâğıt fiş isteyen bir istasyonu "Yazıcıya" ya da "İkisine" çevirin ve ona bir yazıcı bağlayın.',
      'İstasyonu olmayan kategori kalmadığından emin olun; ekran bunları uyarı olarak listeler.',
    ],
    notes: [
      'Varsayılan ekrandır. Bu programda mutfak ve bar siparişi Ekranlar\'dan okur; yazıcı istisnadır ve işletmelerin çoğunda hiç yoktur.',
      'Yazıcısı olmayan bir "Ekrana" istasyonu eksik kurulmuş değildir, olağan olan odur ve ekran onu uyarı olarak göstermez. Uyarı yalnızca yazıcıya göndereceğini söyleyip yazıcısı olmayan istasyona çıkar.',
      'İstasyonu olmayan kategorinin siparişi hiçbir yere gitmez ve mutfak ekranında "İstasyonsuz" rozetinde birikir.',
      'Ekranla çalışan bir istasyonda siparişler saatlerdir bekliyor ve hiçbiri ilerletilmemişse ekran bunu da yazar: panoya kimse bakmıyor demektir.',
    ],
    see: ['fis', 'mutfak', 'products'] },

  { page: 'fis', tab: 'ekran', title: 'Müşteri ekranı',
    lead: 'Kasanın müşteriye dönük ikinci ekranı: karşılama yazısı, küçük bir görsel ve karekod.',
    steps: [
      'Karşılama yazısını yazın.',
      'İsterseniz bir görsel ve sosyal medya hesaplarınızı ekleyin.',
      'İkinci ekranda display sayfasını açın; adisyon işlendikçe orada görünür.',
    ],
    notes: [
      'Bu ekran mevcut düzenin içine iki kutu ekler, düzeni yeniden çizmez.',
      'Instagram, Facebook ve TikTok adresleri fişteki ve karekod kartındaki adreslerle aynı yerden okunur, bu yüzden üçü farklı olamaz.',
    ],
    see: ['fis', 'qrmenu'] },

  { page: 'cihazlar', title: 'Cihazlar',
    lead: 'Kasaya bağlı telefonlar ve tabletler, adisyon ön ekleri, senkron kuyruğu ve bu bilgisayarın bağlantı durumu.',
    steps: [
      'Telefonlar sekmesinde cihaz ekleyin: ekranda çıkan altı haneli kodu telefona yazın.',
      'Ayrılan personelin telefonunun erişimini kesin - o cihaz artık adisyon açamaz.',
      'Senkron ve bağlantı sekmeleri "telefonlar çalışmıyor" sorusunun cevabının bulunduğu yerdir.',
    ],
    notes: [
      'Dört sekme dört ayrı ekran değil, tek bir sorunun dört cevabıdır. Destek telefonunda kimse "kuyruğumda 41 satır bekliyor" demez, "telefonlar durdu" der.',
      'Lisansın bitişi bitmeden önce burada görünür. Eski program bunu, kasanın açılmadığı sabah söylüyordu - hiçbir şey yapılamayacak tek sabah.',
      'Bir cihazın erişimini kesmek numara ön ekini de geri alır; o ön ek başka bir cihaza verilebilir.',
    ],
    see: ['gunluk', 'entegrasyon', 'yedek'] },

  { page: 'cihazlar', tab: 'liste', title: 'Telefonlar ve tabletler',
    lead: 'Kasaya eşleşmiş cihazlar: hangisi kimde, en son ne zaman bağlandı.',
    steps: [
      '"Cihaz ekle" deyin, çıkan kodu telefondaki uygulamaya girin.',
      'Cihazı adlandırın ("Ayşe telefon"), böylece hangisi olduğu belli olsun.',
      'Kaybolan ya da ayrılan personelin cihazının erişimini kesin.',
    ],
    notes: [
      'Eşleştirme kodu sadece bir POST cevabının içinde vardı ve hiçbir ekranda görünmüyordu; artık ekranda çıkar.',
      'Erişimi kesilen cihaz eski adisyonlarını silmez. Yazdıkları yerinde kalır, yenisini yazamaz.',
    ],
    see: ['cihazlar'] },

  { page: 'cihazlar', tab: 'onek', title: 'Adisyon ön ekleri',
    lead: 'Her cihazın kendi numara aralığı. İnternet kesikken bile iki cihazın aynı adisyon numarasını vermemesini bu sağlar.',
    steps: [
      'Bir tablete ön ek verin: 3 numaralı ön ek 30001, 30002 diye sayar.',
      'Kullanılmayan ön ekleri geri alın.',
    ],
    notes: [
      'Bu bilgisayar her zaman 0 ön ekidir ve 1, 2, 3 diye sayar. Cihazlara 1-9 arası verilir; dokuzdan fazlası yoktur, çünkü numara bir adisyon numarasının içine sığmak zorundadır.',
      'Ön ekin amacı numara ayırmak değil, isim alanı ayırmaktır: cuma gününden beri ağa hiç bağlanmamış bir tablet, pazar günü de numara üretebilir.',
    ],
    see: ['cihazlar', 'bills'] },

  { page: 'cihazlar', tab: 'senkron', title: 'Senkron durumu',
    lead: 'Buluta gönderilmeyi bekleyen kayıtlar ve kuyruğun ilerleyip ilerlemediği.',
    steps: [
      'Bekleyen satır sayısına bakın; sıfıra yakınsa kuyruk akıyordur.',
      'Sayı büyüyor ve düşmüyorsa bağlantı sekmesine geçin.',
    ],
    notes: [
      'Tıkanmış kuyruk eskiden tamamen görünmezdi: üç gündür reddedilen bir kuyruk, boş bir kuyrukla birebir aynı görünürdü.',
      'Kuyruk beklerken kasa çalışmaya devam eder. Satış hiçbir zaman buluta bağlı değildir.',
    ],
    see: ['cihazlar', 'yedek'] },

  { page: 'cihazlar', tab: 'baglanti', title: 'Bağlantı durumu',
    lead: 'Lisans, internet, kasanın yerel ağdaki adresi ve telefonların ona nasıl ulaştığı.',
    steps: [
      'Lisansın bitiş tarihine ve kalan süreye bakın.',
      'Kasanın ağdaki adresini not edin; telefonlar ve karekod kartları bu adrese gelir.',
      'İnternet yokken çalışılabilen süreyi (mühlet) buradan görün.',
    ],
    notes: [
      'İnternet kesikken kasa çalışmaya devam eder; lisans bir süre bu bilgisayardan okunur. O süre bitmeden internete bir kez çıkmak yeterlidir.',
      'Kasanın IP adresi değişirse basılmış karekod kartları boşa düşer. Kasaya sabit adres verin.',
    ],
    see: ['cihazlar', 'qrmenu'] },

  { page: 'okc', title: 'ÖKC',
    lead: 'Yeni Nesil yazarkasa cihazları ve kasa tanımları.',
    steps: [
      'Cihaz ekleyin: marka, bağlantı bilgisi ve hangi kasaya bağlı olduğu.',
      'Gerçek cihazınız yoksa simülatörle bütün ödeme akışını deneyin.',
      'Kaydettikten sonra ekranın verdiği uyarıyı okuyun - marka desteği hakkında ne biliyorsak orada yazar.',
    ],
    notes: [
      'Simülatör mali fiş kesmez. Deneme içindir; gerçek satışta kullanılmaz.',
      'Her markanın yanında durumu yazar ve bitmemiş sürücüler için "Gerçek" seçilemez. Bir restoran aradaki farkı kasada, misafir karşısında öğrenmemelidir.',
      'ÖKC ile ödemeyi tamamen kapatmak Ayarlar → İşletme → Genel ayarlar\'dadır.',
    ],
    see: ['isletme', 'kasa', 'fis'] },

  { page: 'yedek', title: 'Yedekleme',
    lead: 'Verinin kopyaları ve gerektiğinde geri yüklenmesi. Bu programda kaybolan bir ayı geri getirebilecek tek ekran budur.',
    steps: [
      'Listede bu bilgisayarda duran ve buluta yüklenmiş yedekleri görün.',
      'Riskli bir şey yapmadan önce "Yedekle" deyin - elle yedek almak birkaç saniyedir.',
      'Yedek sıklığını ve saklama süresini aynı ekrandan ayarlayın.',
      'Geri yüklerken önce yedek incelenir; program size içinde ne olduğunu söyler, sonra onay ister.',
    ],
    notes: [
      'Geri yükleme, yedeğin alındığı andan sonraki HER ŞEYİ siler. Dünkü yedeği yüklemek bugünün bütün satışlarını yok eder.',
      'Geri yüklemeden hemen önce program mevcut hâlin bir kopyasını alır. Yanlış dosyayı yüklediğinizi iki hafta sonra fark ederseniz geri dönülecek yer odur.',
      'Başka bir işletmenin yedeği bu kasaya yüklenmez ve bunun "emin misiniz"i yoktur. Yükleyen kişi başka bir restoranın müşterilerini, personelini ve cirosunu kendi kasasına almış olurdu.',
      'Programın daha yeni bir sürümünden alınmış yedek de reddedilir; eski sürümden alınmış yedek kabul edilir ve yüklendikten sonra güncellenir.',
      'Geri yüklemeyi yalnızca kasanın başındaki kişi başlatabilir. Bunu uzaktan başlatan bir düğme yoktur.',
    ],
    see: ['denetim', 'cihazlar', 'gunluk'] },

  { page: 'paket', title: 'Paket Servis',
    lead: 'Telefonla ve platformlardan gelen tüm teslimatların tek panosu: yeni, hazırlanıyor, yolda, teslim edildi.',
    steps: [
      '"Yeni paket siparişi" telefonla başlar: numarayı yazıp Ara deyin, müşteri ve kayıtlı adresleri gelir.',
      'Adresi seçip devam edin; adisyon ekranı açılır ve ürünleri her zamanki gibi eklersiniz.',
      'Kart üzerindeki tek düğme siparişi bir sonraki kulvara taşır. Yolda diyebilmek için önce kurye seçilir.',
      '"Teslim edildi" derken kuryenin kapıda aldığı tutar sorulur; bu ödeme adisyona işlenir.',
    ],
    notes: [
      'Yemeksepeti, Getir, Trendyol Go ve Migros siparişleri de aynı panoya düşer - ayrı bir ekran yoktur. Rozet siparişin nereden geldiğini söyler.',
      'Turuncu kart geciken siparişdir. Gecikme, o siparişe verilen süreye göre hesaplanır; 6 km bir teslimat 25 dakikada gecikmiş sayılmaz.',
      'Gel-al siparişleri panoya düşmez: taşıyan kimse ve gösterilecek adres yoktur. Yine de normal adisyondur.',
      'Pano kendi kendini tazeler; kimse bakmıyorken gelen sipariş de görünür.',
    ],
    see: ['kurye', 'adresler', 'entegrasyon'] },

  { page: 'kurye', title: 'Kuryeler',
    lead: 'Kimin üzerinde kaç sipariş var, kaç teslimat yaptı, ve işletmenin ne kadar nakdi cebinde duruyor.',
    steps: [
      'Kurye ekleyin - kuryenin kasada kullanıcı hesabı olması gerekmez.',
      'Sipariş atandığında kuryenin vardiyası kendiliğinden açılır.',
      'Kurye döndüğünde "Kasaya teslim al" deyin, parayı sayın ve sayılan tutarı girin.',
    ],
    notes: [
      'Kuryede bekleyen nakit ciroya İKİNCİ kez eklenmez. Para teslim sırasında zaten adisyona işlendi; bu ekran paranın kimde olduğunu takip eder.',
      'Beklenenden farklı bir tutar girilirse fark kaydedilir. Eksik kasa bir konuşmadır, sessizce yazılacak bir şey değildir.',
      'Üzerinde teslim edilmemiş sipariş varken kurye kasası kapatılamaz.',
    ],
    see: ['paket', 'kasa'] },

  { page: 'adresler', title: 'Adresler ve bölgeler',
    lead: 'Müşteri adres defteri ve teslimat ücretinin geldiği bölge tablosu.',
    steps: [
      'İsim, telefon, sokak ya da mahalle yazarak arayın.',
      'Tek ücret uyguluyorsanız yalnızca varsayılan bölgenin ücretini değiştirin.',
      'Uzak semtler için bölge ekleyip adresleri o bölgeye bağlayın.',
    ],
    notes: [
      'Kapı notu ("zil çalışmıyor, arayın") adrese aittir, siparişe değil - bir kez yazılır, her teslimatta kuryenin önüne çıkar.',
      'Adres siparişe kopyalanarak yazılır. Müşteri sonradan adresini değiştirse bile geçmiş teslimatlar gittikleri yeri söylemeye devam eder.',
      'Varsayılan bölge silinemez: her adresin düşeceği bir ücret olmak zorundadır.',
    ],
    see: ['paket', 'guests'] },

  { page: 'platformlar', title: 'Platformlar',
    lead: 'Yemeksepeti, Getir Yemek, Trendyol Go ve Migros Yemek bağlantılarının o anki durumu.',
    steps: [
      'Her kartta platformun bağlı olup olmadığı, hangi ortamda çalıştığı ve panoda kaç siparişi olduğu yazar.',
      '"Şimdi kontrol et" o platformu hemen sorgular - bir sipariş geldi mi diye beklemek yerine.',
      'Simülatör ortamındaki bağlantıya "Deneme siparişi gönder" diyerek boru hattını uçtan uca görebilirsiniz.',
    ],
    notes: [
      'Bu ekran ayar ekranı değildir: anahtarlar, ürün eşleştirme ve günlük Entegrasyon ekranındadır. Buradaki düğme oraya götürür.',
      'Canlı bağlantıya deneme siparişi gönderilemez. Deneme siparişi gerçek adisyon açar, gerçek fiş bastırır - yalnızca karşı taraf simüle edilir.',
      'Bir platformdan sipariş gelmiyorsa önce buraya bakın: bağlantı kapalı mı, ortam yanlış mı, son hata ne diyor.',
    ],
    see: ['paket', 'entegrasyon'] },

  { page: 'paketrapor', title: 'Paket ve kurye raporu',
    lead: 'Gün ya da tarih aralığı için paket sayısı, ciro, teslimat ücreti, kurye performansı ve kurye kasası.',
    steps: [
      'Tarih aralığını seçip Getir deyin.',
      '"Nereden geldi" tablosu telefon ile platformları ayırır.',
      'Kurye performansı tablosu kim kaç teslimat yaptı, ortalama ve en yavaş süresi ne, kaçı zamanında.',
      'Kurye kasası tablosu kimin ne kadar nakit taşıdığını ve kasaya teslimde ne kadar fark çıktığını gösterir.',
    ],
    notes: [
      'Ortalama teslim süresi KURYEYE VERİLDİĞİ andan teslim anına kadardır: mutfağın yavaşlığı kuryenin sırtına yazılmaz.',
      'Gecikme her siparişin kendi söz verilen süresine göre sayılır, tek bir sabit süreye göre değil.',
      'Kasa farkı kapanmış kurye vardiyalarından gelir. Sürekli eksi veren bir kurye tek akşama bakarak görülmez; bu sütun onun içindir.',
    ],
    see: ['paket', 'kurye', 'reports'] },

  { page: 'entegrasyon', title: 'Entegrasyon',
    lead: 'Yemek platformları: Trendyol Go, Yemeksepeti, Migros Yemek, Getir. Bağlantılar, gelen siparişler, ürün eşleştirme ve günlük.',
    steps: [
      'Bağlantılar sekmesinde platformu bağlayın: anahtarlar, şube, siparişi kim karşılayacak, hangi yazıcıdan çıkacak.',
      'Siparişler sekmesi akşam boyunca bakılan yerdir: ne geldi, ne yapılması gerekiyor.',
      'Eşleştirme sekmesinde platformdaki ürünleri kendi ürünlerinizle eşleyin ve menüyü yukarı gönderin.',
      'Bir şey ters gittiğinde Günlük sekmesine bakın ve başarısız olanı yeniden deneyin.',
    ],
    notes: [
      'Kaydedilmiş bir anahtar bir daha gösterilmez, yöneticiye bile. Alan boş bırakılırsa saklanan anahtar olduğu gibi kalır; altındaki maskeli ipucu hangisinin içeride olduğunu söyler.',
      'Eşleşmemiş ürün, platformda karşılığı olmayan üründür. Adı birebir tutan ve otomatik eşleşen ürün gerçek üründür, stoğu ve reçetesi çalışır - o yüzden uyarı olarak sayılmaz.',
      'Her değişiklik günlüğe geçer, anahtarlar çıkarılarak.',
    ],
    see: ['products', 'fis', 'gunluk'] },

  { page: 'entegrasyon', tab: 'siparisler', title: 'Platform siparişleri',
    lead: 'Platformlardan gelen paket ve gel-al siparişleri, ve onlara yapılabilecekler.',
    steps: [
      'Yeni siparişi onaylayın ya da reddedin; onaylanan sipariş adisyona döner ve mutfağa düşer.',
      'Onaylarken hazırlık süresini yazın - platform bunu müşteriye söyler.',
      'Kuryenin durumunu ve ödemenin kapıda mı alınacağını satırda görün.',
    ],
    notes: [
      'Siparişi onaylamak için adisyonunun oluşmuş olması gerekir. Birkaç saniye önce gelmiş bir sipariş "Adisyon henüz oluşturulmadı" der; tekrar deneyin. Platforma "evet" deyip mutfağa fiş çıkaramamak, ikisinin de en kötüsü olurdu.',
      'Siparişi platformun kendi tabletinden karşılıyorsanız buradaki Onayla / Reddet platforma gitmez - platform onu zaten kaydetmiştir. Kasadaki durum yine de ilerler, çünkü mutfağa haber verilmesi gerekir.',
      'Sipariş hiç gelmiyorsa hata mutfakta değil bağlantıdadır: Günlük sekmesi ne olduğunu söyler.',
    ],
    see: ['entegrasyon', 'mutfak', 'order'] },

  { page: 'entegrasyon', tab: 'baglantilar', title: 'Platform bağlantıları',
    lead: 'Hangi platform bağlı, hangi şube, hangi anahtarla ve siparişin nereden çıkacağı.',
    steps: [
      'Platformu seçip anahtarlarını girin, deneme mi gerçek mi olduğunu işaretleyin.',
      'Siparişin hangi yazıcıdan çıkacağını seçin.',
      'Bağlantıyı test edin.',
    ],
    notes: [
      'Anahtar bir daha görünmez. Değiştirmiyorsanız alanı boş bırakın; boş bırakmak "olanı koru" demektir.',
      'Deneme ortamındaki bir bağlantı gerçek sipariş almaz. Akşam sipariş gelmiyorsa önce buraya bakın.',
    ],
    see: ['entegrasyon'] },

  { page: 'entegrasyon', tab: 'eslestirme', title: 'Ürün eşleştirme',
    lead: 'Platformdaki ürünlerin sizin ürünlerinizle eşlenmesi ve menünün platforma gönderilmesi.',
    steps: [
      'Eşleşmemiş ürünleri tek tek kendi ürününüzle eşleyin.',
      'Menü değiştikçe "Menüyü gönder" ile platformdaki listeyi güncelleyin.',
      'Biten ürünü platformda kapatın.',
    ],
    notes: [
      'Eşleşmemiş ürün, platformdan gelen ama sizde karşılığı olmayan üründür. Böyle bir sipariş gizli bir "Entegrasyon" kategorisine düşer ve ne stok ne reçete çalışır.',
      'Adı birebir tutup otomatik eşleşen ürün eşleşmiş sayılır. Sürekli yanan bir uyarı, okunmayan bir uyarıdır.',
    ],
    see: ['entegrasyon', 'products', 'stock'] },

  { page: 'entegrasyon', tab: 'gunluk', title: 'Entegrasyon günlüğü',
    lead: 'Platformlarla yapılan her alışveriş: ne zaman, ne gitti, ne geldi, ne başarısız oldu.',
    steps: [
      'Başarısız satırları bulun ve "Yeniden dene" deyin.',
      '"Sipariş gelmiyor" şikâyeti burada başlar.',
    ],
    notes: [
      'Bu günlük entegrasyona özeldir. Kasanın genel günlüğü Ayarlar → İşlem günlüğü\'ndedir.',
    ],
    see: ['entegrasyon', 'gunluk'] },

  { page: 'gunluk', title: 'İşlem günlüğü',
    lead: 'Kasada ne olduğunun kaydı: kim, ne zaman, neyi yaptı.',
    steps: [
      'Tarihe ve türe göre süzün.',
      'Bir adisyonun ya da ayarın başına ne geldiğini buradan takip edin.',
      'Destek arayacaksanız önce buraya bakın: konuşma "bir şeyler oldu" ile değil, olanla başlasın.',
    ],
    notes: [
      'Silinen adisyonlar, değiştirilen ayarlar ve satış olmadan açılan çekmeceler burada iz bırakır. Eski sistem bunların hiçbirini yazmıyordu; tek kanıt raporda eksilen paraydı.',
      'Günlük silinemez ve düzenlenemez. İşe yaramasının sebebi budur.',
    ],
    see: ['islemler', 'denetim', 'kullanici'] },

  { page: 'denetim', title: 'Güvenlik denetimi',
    lead: 'Bu kasadaki verinin gerçekten bu işletmeye ait olup olmadığının kontrolü.',
    steps: [
      'Denetimi çalıştırın ve satırları okuyun.',
      'Sahipsiz ya da başka işletmeye ait görünen satır varsa destek ile paylaşın.',
    ],
    notes: [
      'Tek işletmelik bir kasada cevabın "evet" olması gerekir - kontrol etmeye değmesinin sebebi tam olarak budur. Sahipsiz bir satır, yedek başka bir bilgisayara yüklendiğinde ortaya çıkar.',
      'Geçen bir kontrol yeşil tikle değil, cümleyle gösterilir. Bu programda hiçbir yerde yeşil yoktur.',
    ],
    see: ['yedek', 'gunluk'] },

  { page: 'kurulum', title: 'Kurulum',
    lead: 'İlk kurulumun yarım kalan kısmı: KDV oranları, iş günü saati, para birimi ve menünün kendisi.',
    steps: [
      'Kullanacağınız KDV oranlarını işaretleyin ve varsayılanı seçin.',
      'İş gününün kaçta başladığını ve para birimini ayarlayın.',
      'Menüyü elle girmek yerine mevcut fiyat listenizi Excel dosyasından aktarın.',
      'Kalan maddeleri tamamlayın; ekran ne kadarının bittiğini gösterir.',
    ],
    notes: [
      'Açılıştaki sihirbaz dört soru sorar ve bırakır: KDV oranı yok, iş günü saati yok, para birimi yok, menü boş. Kalanının kalıcı yeri burasıdır - pazartesi yarım bırakılan iş salı bitirilebilsin diye.',
      'Üç yüz ürünü elle yazmak birinin bir günüdür ve fiyat listesi zaten bir tabloda durur. İçe aktarma önce önizlenir.',
    ],
    see: ['products', 'para', 'isletme'] },

  { page: 'profil', title: 'Profilim',
    lead: 'Kendi adınız, kullanıcı adınız ve kendi kasa PIN\'iniz.',
    steps: [
      'Adınızı düzeltin - fişte ve raporlarda görünen isim budur.',
      'PIN\'inizi değiştirin.',
    ],
    notes: [
      'Burası için yetki gerekmez. Eskiden kendi PIN\'ini değiştirmek yönetici yetkisi isterdi, yani PIN\'ini biri omzunun üstünden görmüş bir kasiyer onu değiştirmek için patronu beklemek zorundaydı.',
      'Başkasının PIN\'i buradan değiştirilmez; o, Kullanıcılar ekranındadır.',
    ],
    see: ['kullanici'] },

  /*
   * Addresses, not screens.
   *
   * page_settings and page_admin redirect to İşletme - an old bookmark, a
   * ?p=settings and every phone that learned the name still land somewhere
   * that draws. Somebody who arrives that way presses F1 on İşletme's help,
   * because that is the screen they are looking at.
   */
  { page: 'settings', alias: 'isletme' },
  { page: 'admin', alias: 'isletme' },

]);
