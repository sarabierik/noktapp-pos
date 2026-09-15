'use strict';
/**
 * DEMO VERİSİ — the fiction.
 *
 * Only the raw material lives here: no SQL, no dates, no randomness. Keeping
 * it apart means the shape of the demo restaurant can be argued about (is the
 * menu believable? are the wages right for 2021?) without reading a line of
 * the code that writes it.
 *
 * The restaurant is KALEİÇİ OCAKBAŞI, Antalya. Opened long before 2020, so a
 * seven year history is not a surprise; a kebap house rather than a cafe,
 * because a kebap house has every kind of line a POS has to cope with - a 720
 * TL mixed grill, a 30 TL bottle of water, half portions, and a bill that ends
 * with six teas.
 */

/* --------------------------------------------------------------- the menu */
/* [name, price today, cost today, vat, stock-tracked] - prices are 2026 and
   the seeder walks them BACKWARDS through seven years of Turkish inflation. */
const MENU = [
  ['Başlangıçlar', 'Mutfak', [
    ['Mercimek Çorbası', 95, 24, 10], ['Ezogelin Çorbası', 95, 25, 10],
    ['Humus', 140, 41, 10], ['Haydari', 120, 33, 10], ['Acılı Ezme', 120, 29, 10],
    ['Muhammara', 150, 48, 10], ['Sigara Böreği (6 adet)', 165, 52, 10],
    ['Zeytinyağlı Yaprak Sarma', 155, 49, 10], ['Patlıcan Söğürme', 160, 47, 10],
  ]],
  ['Ocakbaşı', 'Ocak', [
    ['Adana Kebap', 420, 168, 10], ['Urfa Kebap', 420, 166, 10],
    ['Kuzu Şiş', 520, 231, 10], ['Tavuk Şiş', 360, 126, 10],
    ['Kaburga', 560, 246, 10], ['Ciğer Şiş', 390, 152, 10],
    ['Beyti Sarma', 540, 227, 10], ['Karışık Izgara', 720, 317, 10],
    ['Patlıcan Kebap', 480, 192, 10], ['Kanat (8 adet)', 340, 129, 10],
    ['Köfte (6 adet)', 380, 148, 10], ['Antrikot (250 gr)', 780, 374, 10],
  ]],
  ['Pide ve Lahmacun', 'Pide', [
    ['Kıymalı Pide', 260, 91, 10], ['Kaşarlı Pide', 250, 92, 10],
    ['Kuşbaşılı Kaşarlı Pide', 320, 122, 10], ['Lahmacun', 110, 36, 10],
    ['Etli Ekmek', 280, 101, 10], ['Sucuklu Yumurtalı Pide', 290, 107, 10],
  ]],
  ['Salata ve Meze', 'Mutfak', [
    ['Çoban Salata', 150, 41, 10], ['Gavurdağı Salata', 180, 54, 10],
    ['Roka Salata', 140, 36, 10], ['Mevsim Salata', 150, 39, 10],
    ['Söğüş Tabağı', 90, 23, 10],
  ]],
  ['İçecekler', 'Bar', [
    ['Ayran (30 cl)', 60, 17, 10], ['Şalgam', 65, 19, 10],
    ['Kola (33 cl)', 75, 31, 10], ['Soda', 45, 14, 10], ['Su (50 cl)', 30, 7, 10],
    ['Çay', 35, 6, 10], ['Türk Kahvesi', 90, 22, 10], ['Limonata', 85, 24, 10],
    ['Taze Sıkma Portakal', 120, 47, 10], ['Meyve Suyu', 70, 26, 10],
  ]],
  ['Tatlılar', 'Mutfak', [
    ['Künefe', 260, 88, 10], ['Fıstıklı Baklava (4 dilim)', 290, 112, 10],
    ['Sütlaç', 160, 43, 10], ['Kazandibi', 170, 46, 10],
    ['Dondurma (2 top)', 120, 34, 10], ['Kadayıf', 250, 84, 10],
  ]],
];

/* How often a category is ordered, relative to the others. A kebap house
   sells more drinks than starters and more starters than puddings, and a demo
   whose top seller is Kazandibi does not look like a kebap house. */
const CATEGORY_WEIGHT = {
  'Başlangıçlar': 16, 'Ocakbaşı': 30, 'Pide ve Lahmacun': 14,
  'Salata ve Meze': 11, 'İçecekler': 22, 'Tatlılar': 7,
};

/* ------------------------------------------------------------- the people */
/* [username, display name, role, PIN, phone password, permission keys]
   null perms = the role's own defaults. */
const STAFF = [
  ['erdal',  'Erdal Sarıkaya', 'admin',   '1234', 'Sifre1234', null],
  ['nurcan', 'Nurcan Aydın',   'admin',   '2244', 'Sifre1234', null],
  ['sevim',  'Sevim Korkmaz',  'cashier', '3311', 'Sifre1234',
    ['order.create', 'order.item.cancel', 'order.discount', 'order.transfer',
     'payment.take', 'report.view', 'customer.manage']],
  ['hakan',  'Hakan Tunç',     'cashier', '3322', 'Sifre1234',
    ['order.create', 'order.item.cancel', 'order.transfer', 'payment.take', 'customer.manage']],
  ['emre',   'Emre Doğan',     'waiter',  '4411', 'Sifre1234',
    ['order.create', 'order.transfer', 'customer.manage']],
  ['tugba',  'Tuğba Şen',      'waiter',  '4422', 'Sifre1234',
    ['order.create', 'order.transfer', 'order.item.cancel', 'customer.manage']],
  ['okan',   'Okan Bilgin',    'waiter',  '4433', 'Sifre1234', ['order.create']],
  ['melis',  'Melis Arda',     'waiter',  '4444', 'Sifre1234', ['order.create', 'order.transfer']],
];

/* Who was actually on the payroll when. A waiter list that is identical in
   2020 and 2026 is the tell-tale of generated data, and the waiter report is
   one of the screens being shown. */
const STAFF_TENURE = {
  erdal:  ['2015-01-01', null],          // the owner
  nurcan: ['2015-01-01', null],          // his wife, the manager
  sevim:  ['2018-03-01', null],
  hakan:  ['2022-06-15', null],
  emre:   ['2019-09-01', '2023-11-30'],  // left
  tugba:  ['2021-04-01', null],
  okan:   ['2024-02-01', null],
  melis:  ['2025-05-20', null],
};

const ZONES = [
  ['Salon', 'S', 12, [4, 4, 2, 2, 6, 4, 4, 2, 6, 4, 4, 8]],
  ['Bahçe', 'B', 10, [4, 4, 6, 6, 4, 4, 2, 2, 8, 6]],
  ['Teras', 'T', 6,  [2, 2, 4, 4, 6, 6]],
];

const STATIONS = ['Ocak', 'Mutfak', 'Pide', 'Bar'];

/* ------------------------------------------------------------- the guests */
const FIRST = ['Ayşe', 'Mehmet', 'Zeynep', 'Ali', 'Fatma', 'Mustafa', 'Elif', 'Hüseyin',
  'Hatice', 'İbrahim', 'Emine', 'Ahmet', 'Merve', 'Murat', 'Sultan', 'Yusuf', 'Özlem',
  'Kemal', 'Derya', 'Serkan', 'Gamze', 'Onur', 'Pınar', 'Burak', 'Ebru', 'Cem',
  'Selin', 'Tolga', 'Nazlı', 'Barış', 'Sibel', 'Volkan', 'Ceren', 'Erkan', 'Damla'];
const LAST = ['Kaya', 'Demir', 'Yılmaz', 'Çelik', 'Şahin', 'Yıldız', 'Aydın', 'Öztürk',
  'Arslan', 'Doğan', 'Kılıç', 'Aslan', 'Çetin', 'Kara', 'Koç', 'Kurt', 'Özdemir',
  'Şimşek', 'Polat', 'Erdoğan', 'Güneş', 'Bulut', 'Taş', 'Ateş', 'Yalçın'];

/* --------------------------------------------------------------- the costs */
/* [category, description, monthly amount in 2026 TL, day-of-month]
   The seeder deflates these backwards exactly like the menu prices. */
const FIXED_COSTS = [
  ['Kira', 'Dükkan kirası', 85000, 5],
  ['Personel', 'Maaşlar', 310000, 10],
  ['Elektrik', 'Elektrik faturası', 28000, 18],
  ['Su', 'Su faturası', 4200, 18],
  ['Doğalgaz', 'Doğalgaz faturası', 16000, 20],
  ['İnternet', 'İnternet ve telefon', 2400, 22],
  ['Muhasebe', 'Mali müşavir', 9500, 25],
  ['Vergi', 'Stopaj ve SGK', 62000, 26],
];
/* the ones that turn up when they turn up */
const ADHOC_COSTS = [
  ['Bakım', 'Ocak bakımı', 3500], ['Bakım', 'Klima bakımı', 2800],
  ['Temizlik', 'Temizlik malzemesi', 4200], ['Sarf', 'Peçete ve ambalaj', 5600],
  ['Tanıtım', 'Sosyal medya reklamı', 7500], ['Bakım', 'Buzdolabı tamiri', 6400],
  ['Sarf', 'Kömür', 12000], ['Temizlik', 'Halı yıkama', 2200],
  ['Tanıtım', 'Menü baskısı', 4800], ['Bakım', 'Yazar kasa bakımı', 1800],
];

/* -------------------------------------------------------------- suppliers */
const SUPPLIERS = [
  ['Antalya Et ve Süt A.Ş.', 'Cengiz Bayram', '5331000011', 'Kasaplar Sitesi No:14, Antalya'],
  ['Toros Sebze Meyve', 'Hasan Gürsoy', '5332000022', 'Hal Kompleksi B Blok 27, Antalya'],
  ['Akdeniz İçecek Dağıtım', 'Selim Aksu', '5333000033', 'Organize Sanayi 3. Cad., Antalya'],
  ['Güney Un ve Bakliyat', 'Ramazan Tekin', '5334000044', 'Kepez Sanayi Sitesi, Antalya'],
  ['Kaleiçi Temizlik Ürünleri', 'Murat Eren', '5335000055', 'Fener Mah. 1934 Sk., Antalya'],
];

/* ---------------------------------------------------------- the ingredients */
/* [name, unit, category, cost per unit today, typical stock, critical level] */
const INGREDIENTS = [
  ['Kuzu kıyma', 'kg', 'Et', 620, 45, 15], ['Kuzu but', 'kg', 'Et', 690, 30, 10],
  ['Dana kuşbaşı', 'kg', 'Et', 640, 25, 10], ['Tavuk göğüs', 'kg', 'Et', 210, 35, 12],
  ['Kuzu ciğer', 'kg', 'Et', 380, 12, 5], ['Tavuk kanat', 'kg', 'Et', 190, 20, 8],
  ['Domates', 'kg', 'Sebze', 42, 60, 20], ['Salatalık', 'kg', 'Sebze', 38, 40, 15],
  ['Sivri biber', 'kg', 'Sebze', 55, 25, 10], ['Soğan', 'kg', 'Sebze', 22, 80, 25],
  ['Patlıcan', 'kg', 'Sebze', 48, 30, 10], ['Maydanoz', 'bağ', 'Sebze', 12, 50, 20],
  ['Roka', 'kg', 'Sebze', 65, 12, 5], ['Limon', 'kg', 'Sebze', 45, 25, 10],
  ['Un', 'kg', 'Bakliyat', 26, 100, 30], ['Kırmızı mercimek', 'kg', 'Bakliyat', 58, 40, 15],
  ['Bulgur', 'kg', 'Bakliyat', 34, 50, 20], ['Pirinç', 'kg', 'Bakliyat', 72, 40, 15],
  ['Yoğurt', 'kg', 'Süt', 68, 35, 12], ['Kaşar peyniri', 'kg', 'Süt', 340, 18, 6],
  ['Tereyağı', 'kg', 'Süt', 420, 12, 4], ['Süt', 'lt', 'Süt', 38, 30, 10],
  ['Ayran (30 cl)', 'adet', 'İçecek', 17, 240, 60], ['Kola (33 cl)', 'adet', 'İçecek', 31, 300, 72],
  ['Su (50 cl)', 'adet', 'İçecek', 7, 600, 144], ['Soda', 'adet', 'İçecek', 14, 240, 48],
  ['Şalgam', 'adet', 'İçecek', 19, 120, 24], ['Çay', 'kg', 'İçecek', 380, 15, 5],
  ['Kömür', 'kg', 'Sarf', 28, 200, 60], ['Peçete', 'paket', 'Sarf', 85, 40, 12],
  ['Ambalaj kutusu', 'adet', 'Sarf', 9, 500, 120], ['Poşet', 'paket', 'Sarf', 65, 25, 8],
];

const COURIERS = [
  ['Serkan Uçar', '5351110001'], ['Yasin Kandemir', '5352220002'],
  ['Ufuk Demirtaş', '5353330003'], ['Cihan Polat', '5354440004'],
];

const DELIVERY_ZONES = [
  ['Kaleiçi', 0, 12], ['Muratpaşa', 35, 22], ['Konyaaltı', 60, 35],
  ['Lara', 75, 40], ['Kepez', 55, 30],
];

const STREETS = ['Atatürk Cad.', 'Işıklar Cad.', 'Fener Mah. 1934 Sk.', 'Deniz Mah. 12. Sk.',
  'Barbaros Mah. Hıdırlık Sk.', 'Meltem Mah. 3812 Sk.', 'Şirinyalı Mah. 1509 Sk.',
  'Güzeloba Mah. 2306 Sk.', 'Altındağ Mah. 146 Sk.', 'Bahçelievler Mah. 4. Sk.'];

/* Table notes and bill notes, so the fields are not all NULL on screen. */
const ORDER_NOTES = ['Acılı olmasın', 'Az pişmiş', 'Servis birlikte gelsin',
  'Fatura kesilecek', 'Doğum günü - mum istendi', 'Çocuk sandalyesi',
  'Soğan istemiyorlar', 'Paket olarak toplansın'];

const CANCEL_REASONS = ['Müşteri vazgeçti', 'Yanlış girildi', 'Mutfak yetiştiremedi',
  'Ürün bitti', 'Masa değişti'];

module.exports = {
  MENU, CATEGORY_WEIGHT, STAFF, STAFF_TENURE, ZONES, STATIONS,
  FIRST, LAST, FIXED_COSTS, ADHOC_COSTS, SUPPLIERS, INGREDIENTS,
  COURIERS, DELIVERY_ZONES, STREETS, ORDER_NOTES, CANCEL_REASONS,
};
