'use strict';
/* =====================================================================
   Where everything is.
   =====================================================================

   Declared, not scraped. A tab's label only exists in the DOM once its screen
   has been drawn, and the setting somebody cannot find is by definition the
   one they have not opened - so scraping would index exactly the screens that
   need no index.

   Each entry is one ANSWER to "where do I do X":
     page      the screen to open
     tab       optional: the tab inside it, by the key that screen uses
     label     what it is called, as it is written on the screen
     area      where it lives, so two similarly named things can be told apart
     keywords  what a person would type instead - including the plain word
               ("vergi" for KDV), the abbreviation, and the English if it is
               what the trade actually says ("printer", "stok")
     perm      hidden from staff who cannot use it

   Keep keywords honest: a keyword that makes an entry appear for an unrelated
   search is worse than no entry, because it pushes the right answer down.
   ===================================================================== */
registerSearch([
  /* ------------------------------------------------------------ satış */
  { page: 'tables', label: 'Masalar', area: 'Satış',
    keywords: ['masa', 'salon', 'oturma', 'adisyon aç', 'table', 'paket', 'gel al', 'hızlı satış'] },
  { page: 'tables', label: 'Masa birleştirme', area: 'Satış',
    keywords: ['birleştir', 'grup', 'masaları birleştir', 'tek adisyon', 'kalabalık'] },
  { page: 'duzen', label: 'Masa düzeni', area: 'Satış', perm: 'table.manage',
    keywords: ['masa ekle', 'bölge', 'kat', 'plan', 'masa sil', 'salon düzeni'] },
  { page: 'rezervasyon', label: 'Rezervasyon', area: 'Satış',
    keywords: ['rezerve', 'ayırt', 'booking'] },
  { page: 'mutfak', label: 'İstasyon ekranları', area: 'Satış',
    keywords: ['ekranlar', 'mutfak', 'bar', 'pide', 'tatlı', 'istasyon ekranı',
               'sipariş ekranı', 'hazırlanıyor', 'kds', 'pano'] },
  { page: 'bills', label: 'Adisyonlar', area: 'Satış',
    keywords: ['açık adisyon', 'kapanmış', 'fiş tekrar', 'yeniden yazdır', 'geri aç'] },
  { page: 'kasa', label: 'Kasa', area: 'Satış', perm: 'payment.take',
    keywords: ['vardiya', 'kasa aç', 'para', 'çekmece', 'kupür', 'sayım', 'nakit'] },
  { page: 'vardiyalar', label: 'Vardiya geçmişi', area: 'Kasa', perm: 'report.view',
    keywords: ['vardiya', 'eksik fazla', 'kasiyer', 'devir'] },

  /* --------------------------------------------------------- raporlar */
  { page: 'reports', label: 'Raporlar', area: 'Rapor', perm: 'report.view',
    keywords: ['ciro', 'z raporu', 'x raporu', 'gün sonu', 'satış'] },
  { page: 'reports', label: 'Z raporu', area: 'Rapor', perm: 'report.view',
    keywords: ['z raporu', 'gün sonu raporu', 'kdv dökümü', 'mali rapor'] },
  { page: 'reports', label: 'Dönem raporu ve dışa aktarma', area: 'Rapor', perm: 'report.export',
    keywords: ['csv', 'excel', 'pdf', 'dışa aktar', 'muhasebe', 'dönem', 'export'] },
  { page: 'pnl', label: 'Kâr / Zarar', area: 'Rapor', perm: 'report.view',
    keywords: ['kar', 'zarar', 'marj', 'maliyet', 'kazanç', 'profit'] },
  { page: 'finans', label: 'Finans', area: 'Rapor', perm: 'report.view',
    keywords: ['ödeme dağılımı', 'nakit', 'kredi kartı', 'indirimler', 'iptaller'] },
  { page: 'gunsonu', label: 'Gün sonu', area: 'Rapor', perm: 'report.view',
    keywords: ['gün kapat', 'kapanış', 'gün detayı', 'gün aç'] },
  { page: 'islemler', label: 'İşlemler', area: 'Rapor', perm: 'report.view',
    keywords: ['adisyon iptal', 'sil', 'kalıcı sil', 'geri al', 'iade', 'kapanmış adisyon', 'tahsilat'] },
  { page: 'gunluk', label: 'İşlem günlüğü', area: 'Ayarlar', perm: 'report.view',
    keywords: ['denetim', 'kim yaptı', 'log', 'kayıt', 'audit'] },

  /* ------------------------------------------------------------ menü */
  { page: 'products', label: 'Ürünler', area: 'Menü', perm: 'product.manage',
    keywords: ['menü', 'ürün ekle', 'fiyat', 'kategori', 'kdv', 'porsiyon'] },
  { page: 'products', label: 'KDV oranı (ürün)', area: 'Menü', perm: 'product.manage',
    keywords: ['kdv', 'vergi', 'oran', 'yüzde 10', 'yüzde 20', 'vat'] },
  { page: 'products', label: 'Menüyü içe / dışa aktar', area: 'Menü', perm: 'product.manage',
    keywords: ['excel', 'csv', 'toplu ürün', 'içe aktar', 'import'] },
  { page: 'fiyat', label: 'Fiyatlandırma', area: 'Menü', perm: 'price.manage',
    keywords: ['zam', 'toplu fiyat', 'marj', 'hedef', 'fiyat değiştir'] },
  { page: 'fiyat', tab: 'toplu', label: 'Toplu fiyat değişimi', area: 'Fiyatlandırma', perm: 'price.manage',
    keywords: ['zam', 'toplu', 'yüzde artır', 'fiyat güncelle'] },
  { page: 'fiyat', tab: 'hedef', label: 'Hedef marj', area: 'Fiyatlandırma', perm: 'price.manage',
    keywords: ['marj', 'kar oranı', 'hedef'] },

  /* ------------------------------------------------------------ stok */
  { page: 'stock', label: 'Stok', area: 'Stok', perm: 'stock.manage',
    keywords: ['depo', 'malzeme', 'stok durumu', 'kalan'] },
  { page: 'stock', tab: 'recete', label: 'Reçeteler', area: 'Stok', perm: 'stock.manage',
    keywords: ['reçete', 'içerik', 'hammadde', 'gramaj'] },
  { page: 'stock', tab: 'alis', label: 'Alış faturaları', area: 'Stok', perm: 'stock.manage',
    keywords: ['fatura', 'tedarikçi', 'irsaliye', 'mal alım', 'giriş'] },
  { page: 'stock', tab: 'sayim', label: 'Sayım', area: 'Stok', perm: 'stock.manage',
    keywords: ['sayım', 'fark', 'envanter'] },
  { page: 'stock', tab: 'zayi', label: 'Zayi', area: 'Stok', perm: 'stock.manage',
    keywords: ['zayi', 'fire', 'bozuldu', 'atık', 'kayıp'] },
  { page: 'stock', tab: 'transfer', label: 'Depo transferi', area: 'Stok', perm: 'stock.manage',
    keywords: ['transfer', 'şube', 'depo'] },

  /* --------------------------------------------------------- müşteri */
  { page: 'guests', label: 'Müşteri', area: 'Müşteri',
    keywords: ['müşteri', 'misafir', 'telefon', 'cari'] },
  { page: 'qrmenu', label: 'QR menü', area: 'Müşteri', perm: 'settings.manage',
    keywords: ['karekod', 'qr', 'menü linki', 'tasarım', 'şablon', 'masa karekodu'] },
  { page: 'qrmenu', label: 'Masa karekod kartları', area: 'Müşteri', perm: 'settings.manage',
    keywords: ['karekod', 'qr', 'masa kartı', 'a5', 'yazdır', 'kart'] },
  { page: 'sadakat', label: 'Sadakat', area: 'Müşteri',
    keywords: ['sadakat', 'puan', 'damga', 'ödül', 'kampanya', 'pass'] },
  { page: 'musteri', label: 'Müşteri kartı', area: 'Müşteri', perm: 'customer.manage',
    keywords: ['müşteri kartı', 'geçmiş', 'harcama'] },

  /* ------------------------------------------------- paket / platform */
  /* This screen existed for a whole release with no way to find it: somebody
     typing "trendyol" got "eşleşen bir şey yok" while the screen sat two taps
     away. The platform names ARE the search terms here - nobody looks for
     "entegrasyon", they look for the company whose order has not arrived. */
  { page: 'entegrasyon', label: 'Yemek platformları', area: 'Paket', perm: 'settings.manage',
    keywords: ['entegrasyon', 'trendyol', 'trendyol go', 'tgo', 'uber eats', 'yemeksepeti',
               'getir', 'getir yemek', 'migros', 'migros yemek', 'platform', 'paket sipariş',
               'online sipariş', 'kurye', 'menü gönder'] },

  /* ---------------------------------------------------------- paket */
  /* A cashier looking for the delivery board types the thing they are doing -
     "paket", "kurye", "adres" - and a restaurant that calls it "eve servis"
     types that. The platform names stay on the Entegrasyon row above: those
     are a SETUP question, and this is the board somebody works. */
  { page: 'paket', label: 'Paket servis panosu', area: 'Paket', perm: 'delivery.order',
    keywords: ['paket', 'paket servis', 'eve servis', 'teslimat', 'delivery', 'pano',
               'gelen sipariş', 'telefon siparişi', 'sipariş al', 'yolda', 'teslim edildi'] },
  { page: 'kurye', label: 'Kuryeler ve kurye kasası', area: 'Paket', perm: 'delivery.order',
    keywords: ['kurye', 'motor', 'moto kurye', 'kurye kasa', 'kuryeden para', 'teslim al',
               'kurye vardiya', 'nakit teslim', 'kurye hesabı'] },
  { page: 'adresler', label: 'Adres defteri', area: 'Paket', perm: 'delivery.order',
    keywords: ['adres', 'adres defteri', 'müşteri adresi', 'mahalle', 'sokak', 'kapı notu',
               'adres ara'] },
  { page: 'adresler', label: 'Teslimat bölgeleri ve ücreti', area: 'Paket', perm: 'delivery.manage',
    keywords: ['teslimat ücreti', 'bölge', 'kurye ücreti', 'paket ücreti', 'servis ücreti',
               'minimum sepet', 'alt limit', 'bölge ekle'] },
  { page: 'platformlar', label: 'Platform durumu', area: 'Paket', perm: 'delivery.order',
    keywords: ['platform', 'yemeksepeti', 'getir', 'getir yemek', 'trendyol', 'trendyol go',
               'migros', 'migros yemek', 'bağlı mı', 'deneme siparişi', 'sipariş gelmiyor'] },
  { page: 'paketrapor', label: 'Paket ve kurye raporu', area: 'Paket', perm: 'report.view',
    keywords: ['paket rapor', 'teslimat raporu', 'kurye raporu', 'kurye performans',
               'kaç paket', 'paket cirosu', 'kurye kasa farkı', 'zamanında teslimat'] },

  /* ------------------------------------------------------------ para */
  /*
   * Money first, and DÖVİZ is the reason this file was rewritten.
   *
   * Seven rows here used to name page 'settings'. "Ayarlar" is the NAME of a
   * sidebar group; the screen holding those tabs was registered as 'admin'.
   * So for a whole release, typing "döviz" - or "kdv", "yazıcı", "ökc",
   * "personel" - found the right row, showed it, and opened a group header
   * that draws nothing at all. The search was not broken in any way the code
   * would show you: the entries were there, the words matched, the list
   * appeared. Only the last step, the one nobody re-reads, was addressed to a
   * screen that did not exist.
   *
   * The rule that came out of it: one concept, one search, EVERY place it
   * touches. "Döviz" is four different answers - where the rate is written,
   * where the para birimi is set, whether it goes on the fiş, and who changed
   * it last - and a person typing the word means whichever of them they are
   * standing in front of. Each row names the screen it opens, so two similar
   * answers can be told apart before the click, not after it.
   */
  { page: 'doviz', label: 'Döviz kurları', area: 'Para', perm: 'settings.manage',
    keywords: ['döviz', 'kur', 'euro', 'dolar', 'sterlin', 'yabancı para', 'kur gir',
               'günlük kur', 'kasa kuru', 'exchange', 'eur', 'usd', 'gbp'] },
  { page: 'doviz', label: 'Son kur değişiklikleri', area: 'Para → Döviz kurları', perm: 'settings.manage',
    keywords: ['döviz', 'kur geçmişi', 'kur değişikliği', 'kuru kim değiştirdi', 'eski kur'] },
  { page: 'para', label: 'Para birimi ve kuruş yuvarlama', area: 'Para → Para ve KDV', perm: 'settings.manage',
    keywords: ['döviz', 'para birimi', 'para', 'türk lirası', 'lira', 'tl', 'simge', 'kuruş',
               'kuruş hanesi', 'yuvarlama', 'nakit yuvarlama', 'currency'] },
  { page: 'para', label: 'KDV oranları (menüdeki oranlar)', area: 'Para → Para ve KDV', perm: 'settings.manage',
    keywords: ['kdv', 'vergi', 'oran', 'vat', 'kdv oranı', 'varsayılan kdv'] },

  /* --------------------------------------------------------- ayarlar */
  { page: 'isletme', tab: 'bilgi', label: 'İşletme bilgileri', area: 'Ayarlar → İşletme', perm: 'settings.manage',
    keywords: ['işletme', 'unvan', 'vergi no', 'vkn', 'vergi dairesi', 'adres', 'telefon',
               'firma', 'ticari unvan', 'iletişim kişisi'] },
  { page: 'isletme', tab: 'bilgi', label: 'Çalışma saatleri ve iş günü', area: 'Ayarlar → İşletme', perm: 'settings.manage',
    keywords: ['iş günü', 'gün başlangıcı', 'çalışma saati', 'açılış', 'kapanış', 'gece yarısı'] },
  { page: 'isletme', tab: 'bilgi', label: 'Fiş hangi istasyondan çıksın', area: 'Ayarlar → İşletme', perm: 'settings.manage',
    keywords: ['fiş istasyonu', 'fiş nereden çıkar', 'kasa yazıcısı', 'hesap fişi istasyonu'] },
  { page: 'isletme', tab: 'genel', label: 'Genel ayarlar', area: 'Ayarlar → İşletme', perm: 'settings.manage',
    keywords: ['ayar', 'ayarlar', 'mutfak ayarları', 'ödeme ayarları', 'indirim sınırı',
               'smtp', 'e-posta sunucusu', 'ağ', 'servis portu', 'panel adresi'] },
  { page: 'isletme', tab: 'genel', label: 'PIN kuralları ve yönetici onayı', area: 'Ayarlar → İşletme', perm: 'settings.manage',
    keywords: ['pin', 'pin uzunluğu', 'yönetici pin', 'kilit süresi', 'hatalı pin', 'güvenlik',
               'ekran kilidi'] },
  { page: 'isletme', tab: 'genel', label: 'ÖKC ile ödemeyi aç / kapat', area: 'Ayarlar → İşletme', perm: 'settings.manage',
    keywords: ['ökc', 'yazarkasa', 'mali ödeme', 'ökc ödeme'] },

  { page: 'kullanici', label: 'Kullanıcılar ve yetkiler', area: 'Ayarlar', perm: 'user.manage',
    keywords: ['kullanıcı', 'personel', 'garson', 'kasiyer', 'yetki', 'rol', 'işletme sahibi',
               'personel ekle', 'hesap kapat'] },
  { page: 'kullanici', label: 'Kasa PIN sıfırlama ve kilit açma', area: 'Ayarlar → Kullanıcılar', perm: 'user.manage',
    keywords: ['kullanıcı', 'pin', 'pin sıfırla', 'pin unuttum', 'şifre', 'kilitli', 'kilidi aç'] },

  { page: 'okc', label: 'ÖKC cihazları', area: 'Ayarlar', perm: 'settings.manage',
    keywords: ['ökc', 'yazarkasa', 'yeni nesil', 'mali', 'ingenico', 'hugin', 'beko', 'profilo',
               'fiscal', 'simülatör', 'mali fiş'] },
  { page: 'okc', label: 'Kasalar (ÖKC)', area: 'Ayarlar → ÖKC', perm: 'settings.manage',
    keywords: ['ökc', 'kasa tanımı', 'kasa ekle', 'register'] },

  /*
   * Yedekleme, and geri yükleme with it.
   *
   * Both lived on the deleted screen, reachable only by clicking a sidebar
   * group head - so the one screen in this program that can put a lost month
   * back was findable by nobody who did not already know where it was. The
   * words are the ones somebody types on the worst morning of their year.
   */
  { page: 'yedek', label: 'Yedekleme', area: 'Ayarlar', perm: 'settings.manage',
    keywords: ['yedek', 'yedekleme', 'backup', 'yedek al', 'buluta yükle', 'bulut yedeği'] },
  { page: 'yedek', label: 'Geri yükleme', area: 'Ayarlar → Yedekleme', perm: 'settings.manage',
    keywords: ['yedek', 'geri yükle', 'geri yükleme', 'restore', 'yedekten dön', 'veriyi geri al',
               'veri kayboldu', 'disk bozuldu', 'bilgisayar değişti', 'eski veriye dön'] },
  { page: 'yedek', label: 'Yedek sıklığı ve saklama süresi', area: 'Ayarlar → Yedekleme', perm: 'settings.manage',
    keywords: ['yedek', 'yedekleme sıklığı', 'kaç günde bir', 'saklama süresi', 'bulut yedeği saati'] },

  { page: 'denetim', label: 'Güvenlik denetimi', area: 'Ayarlar', perm: 'settings.manage',
    keywords: ['denetim', 'güvenlik', 'sahipsiz veri', 'veri kontrolü', 'işletme kimliği', 'self check'] },

  /* --------------------------------------------------- yazıcı ve fiş */
  { page: 'fis', tab: 'fis', label: 'Fiş ayarları', area: 'Yazıcı ve fiş', perm: 'settings.manage',
    keywords: ['fiş', 'başlık', 'alt yazı', 'fiş başlığı', '58mm', '80mm', 'kağıt', 'kopya'] },
  { page: 'fis', tab: 'fis', label: 'Fişte döviz gösterimi', area: 'Yazıcı ve fiş → Fiş', perm: 'settings.manage',
    keywords: ['döviz', 'fişte döviz', 'euro fiş', 'kur fişte', 'yabancı para karşılığı'] },
  { page: 'fis', tab: 'fis', label: 'Fişte KDV dökümü', area: 'Yazıcı ve fiş → Fiş', perm: 'settings.manage',
    keywords: ['kdv', 'vergi', 'kdv dökümü', 'fişte kdv', 'vat'] },
  { page: 'fis', tab: 'fis', label: 'Fişteki karekod', area: 'Yazıcı ve fiş → Fiş', perm: 'settings.manage',
    keywords: ['karekod', 'qr', 'fişte qr', 'sadakat karekodu', 'menü karekodu'] },
  { page: 'fis', tab: 'yazici', label: 'Yazıcılar ve yazdırma kuyruğu', area: 'Yazıcı ve fiş', perm: 'printer.manage',
    keywords: ['yazıcı', 'printer', 'yazıcı ekle', 'ip', 'test baskı', 'çekmece', '9100',
               'kuyruk', 'basmıyor', 'termal'] },
  { page: 'fis', tab: 'istasyon', label: 'İstasyonlar', area: 'Yazıcı ve fiş', perm: 'settings.manage',
    keywords: ['istasyon', 'mutfak', 'bar', 'pide', 'tatlı', 'station', 'nereye basar',
               'kategori istasyonu'] },
  { page: 'fis', tab: 'istasyon', label: 'Siparişler ekrana mı yazıcıya mı gitsin', area: 'Yazıcı ve fiş', perm: 'settings.manage',
    keywords: ['ekrana gönder', 'yazıcıya gönder', 'çıkış', 'istasyon çıkışı', 'yazıcısız mutfak',
               'ekransız', 'fiş çıkmıyor', 'mutfak fişi çıkmıyor'] },
  { page: 'fis', tab: 'ekran', label: 'Müşteri ekranı', area: 'Yazıcı ve fiş', perm: 'settings.manage',
    keywords: ['müşteri ekranı', 'ikinci ekran', 'karşılama', 'qr', 'görsel',
               'instagram', 'facebook', 'tiktok', 'sosyal medya'] },

  /* ---------------------------------------------------------- sistem */
  { page: 'cihazlar', tab: 'liste', label: 'Telefonlar ve tabletler', area: 'Ayarlar → Cihazlar', perm: 'settings.manage',
    keywords: ['telefon', 'tablet', 'garson telefonu', 'eşleştir', 'eşleştirme kodu',
               'erişimi kes', 'cihaz ekle'] },
  { page: 'cihazlar', label: 'Cihazlar ve lisans', area: 'Ayarlar', perm: 'settings.manage',
    keywords: ['lisans', 'cihaz', 'senkron', 'bağlantı', 'internet',
               'şube', 'şube kodu', 'merkez menü', 'zincir'] },
  { page: 'kurulum', label: 'Kurulum sihirbazı', area: 'Ayarlar', perm: 'settings.manage',
    keywords: ['kurulum', 'baştan', 'sihirbaz', 'ilk ayar'] },
  { page: 'profil', label: 'Profilim', area: 'Ayarlar',
    keywords: ['şifremi değiştir', 'pin değiştir', 'kendi hesabım', 'kendi pinim'] },
]);
