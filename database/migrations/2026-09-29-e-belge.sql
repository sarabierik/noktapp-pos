-- ---------------------------------------------------------------------------
-- e-FATURA / e-ARSIV  (QNB eSolutions)                          2026-09-29
--
-- Noktappera'nin QNB entegrasyonu POS'a tasiniyor. Protokol tarafinda hicbir
-- sey degismedi: WS-Security SOAP, UBL-TR 1.2, e-Arsiv esZamanli /
-- e-Fatura kuyruklu, ETTN gondermeden once yazilir.
--
-- POS'ta BASKA olan sey: POS'un FATURASI YOKTU. Noktappera bir perakende
-- programi ve invoices/invoice_items tablolari zaten vardi; POS bir adisyon
-- programi ve mali belge olarak yalnizca OKC fisi kesiyordu. Yani bu goc
-- sadece bir entegrasyonu degil, kasaya FATURA KAVRAMINI da getiriyor.
--
-- AKIS: normal satis OKC'den fisle gecer. Musteri fatura isterse kapanmis
-- adisyon acilir, "Fatura olustur" denir; belge e-Arsiv mi e-Fatura mi
-- olacagina mukellef sorgusu karar verir ve faturaya su not otomatik duser:
--   "Bu fatura <tarih> tarihli <fis no> no'lu OKC fisine istinaden
--    duzenlenmistir."
-- ---------------------------------------------------------------------------

-- 1. Fatura baslikligi -------------------------------------------------------
--
-- Alici bilgileri BURADA durur, customers'ta degil: customers sadakat
-- misafiridir (ad, telefon, e-posta) ve vergi kimligi yoktur. Fatura alicisi
-- ise unvan + VKN/TCKN + vergi dairesi + adres ister ve ayni misafir farkli
-- faturalarda farkli sirket adina fatura isteyebilir.
CREATE TABLE IF NOT EXISTS `invoices` (
  `id`            bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`     int(11) NOT NULL,
  `order_id`      int(10) UNSIGNED DEFAULT NULL COMMENT 'Hangi adisyondan kesildi',
  `kind`          enum('sale','return') NOT NULL DEFAULT 'sale',
  `parent_id`     bigint(20) UNSIGNED DEFAULT NULL COMMENT 'IADE faturasinda asil fatura',
  `split_key`     varchar(40) DEFAULT NULL
      COMMENT 'Bolunmus hesapta bu faturanin payi - ayni adisyondan birden fazla fatura cikar',
  `issue_date`    date NOT NULL,
  `full_no`       varchar(40) NOT NULL COMMENT 'NOKTApp kendi seri-sira numarasi (yerel)',
  `note`          varchar(500) DEFAULT NULL,

  `cust_title`    varchar(200) NOT NULL,
  `cust_tax_no`   varchar(11) NOT NULL,
  `cust_tax_office` varchar(120) DEFAULT NULL,
  `cust_address`  varchar(400) DEFAULT NULL,
  `cust_email`    varchar(190) DEFAULT NULL,
  `cust_phone`    varchar(50) DEFAULT NULL,
  `customer_id`   int(10) UNSIGNED DEFAULT NULL COMMENT 'Sadakat misafiri, varsa',

  `subtotal_minor` bigint(20) NOT NULL DEFAULT 0,
  `vat_minor`      bigint(20) NOT NULL DEFAULT 0,
  `total_minor`    bigint(20) NOT NULL DEFAULT 0,

  `fis_no`        varchar(48) DEFAULT NULL COMMENT 'Istinat edilen OKC mali fis no',
  `fis_date`      datetime DEFAULT NULL,
  `fiscal_receipt_id` bigint(20) UNSIGNED DEFAULT NULL,

  `status`        enum('draft','issued','cancelled') NOT NULL DEFAULT 'issued',
  `created_by`    int(11) DEFAULT NULL,
  `created_at`    datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`    datetime DEFAULT NULL ON UPDATE current_timestamp(),

  -- e-belge alanlari (Noktappera ile AYNI adlar; ortak modul bunlari okur)
  `edoc_type`     varchar(10) DEFAULT NULL COMMENT 'EFATURA | EARSIV',
  `edoc_uuid`     char(36) DEFAULT NULL COMMENT 'ETTN - gondermeden ONCE yazilir',
  `edoc_no`       varchar(24) DEFAULT NULL,
  `edoc_oid`      varchar(64) DEFAULT NULL,
  `edoc_state`    varchar(16) DEFAULT NULL COMMENT 'gonderiliyor|kuyrukta|tamam|hata|belirsiz|iptal',
  `edoc_error`    varchar(500) DEFAULT NULL,
  `edoc_url`      varchar(500) DEFAULT NULL,
  `edoc_label`    varchar(120) DEFAULT NULL COMMENT 'Alicinin GIB posta kutusu etiketi',
  `edoc_sent_at`  datetime DEFAULT NULL,
  `edoc_env`      varchar(8) DEFAULT NULL COMMENT 'test | canli - belgenin OLUSTUGU ortam',

  PRIMARY KEY (`id`),
  -- Ayni ETTN iki faturaya yazilamaz. Cift fatura kesilmesine karsi son duvar.
  UNIQUE KEY `uq_inv_edoc_uuid` (`client_id`,`edoc_uuid`),
  UNIQUE KEY `uq_inv_no` (`client_id`,`full_no`),
  KEY `ix_inv_order` (`client_id`,`order_id`),
  KEY `ix_inv_state` (`client_id`,`edoc_state`),
  KEY `ix_inv_date` (`client_id`,`issue_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- 2. Fatura kalemleri --------------------------------------------------------
--
-- order_item_id ile adisyon satirina baglanir ve (client_id, order_item_id,
-- split_key) BENZERSIZDIR: bolunmus hesapta ayni satir iki kez faturalanamaz.
-- Bu, veritabanindan gelen bir garanti; ekranin dikkatli olmasina birakilmis
-- degil.
CREATE TABLE IF NOT EXISTS `invoice_items` (
  `id`            bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`     int(11) NOT NULL,
  `invoice_id`    bigint(20) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `name`          varchar(250) NOT NULL,
  `qty`           int(11) NOT NULL DEFAULT 1000 COMMENT 'Binde: 1 adet = 1000',
  `unit`          varchar(16) NOT NULL DEFAULT 'adet',
  `base_amount`   bigint(20) NOT NULL DEFAULT 0 COMMENT 'Matrah, kurus',
  `vat_rate`      decimal(5,2) NOT NULL DEFAULT 0.00,
  `vat_amount`    bigint(20) NOT NULL DEFAULT 0 COMMENT 'KDV, kurus',
  `is_gift`       tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Ikram: 0 tutarla gorunur',
  PRIMARY KEY (`id`),
  KEY `ix_ii_inv` (`invoice_id`,`id`),
  KEY `ix_ii_order_item` (`client_id`,`order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- Bir adisyon satiri EN FAZLA BIR KEZ faturalanir.
--
-- Anahtar bilerek (client_id, order_item_id) - invoice_id DAHIL DEGIL. Ucunu
-- birlikte benzersiz yapmak hicbir sey korumazdi: iki ayri fatura iki ayri
-- invoice_id demektir ve ayni adisyon satiri her ikisine de girebilirdi. Asil
-- korkulan sey de tam buydu; bolunmus hesapta "1 numarali masanin kebabi" iki
-- musteriye de faturalanamaz.
--
-- Iptal edilen fatura satirin uzerindeki hakki birakir: modul iptalde
-- order_item_id yi NULL a ceker (ad ve tutarlar kayitta kalir), boylece satir
-- yeniden faturalanabilir. MariaDB'de benzersiz anahtar birden fazla NULL a
-- izin verir; kismi indeks (WHERE ...) yoktur, bu yuzden kural boyle kuruldu.
--
-- NOT: anahtarin adi bilerek yeni. Bu dosyanin ilk halinde ayni ad uc kolonlu
-- (client_id, order_item_id, invoice_id) kurulmustu ve hicbir sey korumuyordu;
-- "IF NOT EXISTS" o yanlis anahtari oldugu yerde birakirdi. Eskisi varsa
-- dusurulur, dogrusu yeni adla kurulur. DROP INDEX IF EXISTS yok olan indekste
-- bedava oldugu icin bu dosya her acilista yeniden kosabilir.
ALTER TABLE `invoice_items` DROP INDEX IF EXISTS `uq_ii_once`;
ALTER TABLE `invoice_items`
  ADD UNIQUE KEY IF NOT EXISTS `uq_ii_adisyon_satiri` (`client_id`,`order_item_id`);

-- 3. Indirim / servis ucreti (UBL AllowanceCharge) ---------------------------
--
-- Sahte kalem olarak YAZILMAZ. "Servis ucreti" adinda 0 KDV'li bir urun
-- uydurmak faturayi da raporu da bozar; UBL'in kendi alani var.
CREATE TABLE IF NOT EXISTS `invoice_charges` (
  `id`          bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`   int(11) NOT NULL,
  `invoice_id`  bigint(20) UNSIGNED NOT NULL,
  `is_charge`   tinyint(1) NOT NULL DEFAULT 1 COMMENT '1 = ilave (servis), 0 = indirim',
  `reason`      varchar(120) NOT NULL,
  `base_amount` bigint(20) NOT NULL DEFAULT 0,
  `vat_rate`    decimal(5,2) NOT NULL DEFAULT 0.00,
  `vat_amount`  bigint(20) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `ix_ic_inv` (`invoice_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- 4. QNB iletisim kaydi ------------------------------------------------------
--
-- PAROLA BURAYA ASLA YAZILMAZ. Kaydedilen: islem adi, HTTP durumu, QNB sonuc
-- kodu ve metni, sure. OKC tarafinda ayni bosluk bir ay boyunca hicbir sey
-- yazmadigi icin bir reddi telefonla okumak zorunda kalmistik.
CREATE TABLE IF NOT EXISTS `ebelge_log` (
  `id`          bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`   int(11) NOT NULL,
  `invoice_id`  bigint(20) UNSIGNED DEFAULT NULL,
  `servis`      varchar(12) NOT NULL COMMENT 'efatura | earsiv',
  `islem`       varchar(48) NOT NULL,
  `http_status` smallint(5) UNSIGNED DEFAULT NULL,
  `sonuc_kodu`  varchar(32) DEFAULT NULL,
  `sonuc_metni` varchar(500) DEFAULT NULL,
  `duration_ms` int(10) UNSIGNED DEFAULT NULL,
  `created_at`  datetime(3) NOT NULL DEFAULT current_timestamp(3),
  PRIMARY KEY (`id`),
  KEY `ix_eblog` (`client_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- 5. Gelen e-Fatura ----------------------------------------------------------
--
-- Tedarikciden gelen belgeler. Icerik TEDARIKCIDEN gelir: zip bombasina karsi
-- acma siniri modulde.
--
-- ORTAM ANAHTARIN PARCASI. Ayni ETTN test ve canli ortamda AYRI satirdir:
-- testte cekilmis bir belge canli ortamda listede gorunmez ve yanitlanamaz.
-- Bunu (client_id, uuid) ile kurmak, test verisinin canliya sizmasina izin
-- verirdi.
--
-- Kabul/red 8 gun icinde ve yalnizca TICARI profilde. TEMEL faturaya yanit
-- verilmez; sure dolarsa fatura kabul edilmis sayilir.
CREATE TABLE IF NOT EXISTS `gelen_belge` (
  `id`           bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`    int(11) NOT NULL,
  `ortam`        varchar(8) NOT NULL DEFAULT 'test' COMMENT 'test | canli - belgenin GELDIGI ortam',
  `uuid`         char(36) NOT NULL COMMENT 'Belgenin ETTN si',
  `belge_no`     varchar(32) DEFAULT NULL,
  `belge_tarihi` date DEFAULT NULL,
  `gelis_tarihi` date DEFAULT NULL COMMENT '8 gunluk yanit suresi BURADAN sayilir',
  `senaryo`      varchar(24) DEFAULT NULL COMMENT 'TEMELFATURA | TICARIFATURA | IHRACAT | KAMU',
  `gonderen_vkn` varchar(11) DEFAULT NULL,
  `gonderen`     varchar(200) DEFAULT NULL,
  `gonderen_etiket` varchar(120) DEFAULT NULL COMMENT 'Yanit BU posta kutusuna gider',
  `tutar_minor`  bigint(20) NOT NULL DEFAULT 0,
  `doviz`        varchar(3) NOT NULL DEFAULT 'TRY',

  -- QNB tarafinda yanitlanmis mi (portalden yanitlanmis olabilir)
  `qnb_yanit`    tinyint(1) NOT NULL DEFAULT 0,
  `qnb_yanit_detay` varchar(200) DEFAULT NULL,

  `yanit`        varchar(8) DEFAULT NULL COMMENT 'KABUL | RED',
  `yanit_neden`  varchar(500) DEFAULT NULL,
  -- Yanit ETTN si GONDERMEDEN ONCE yazilir: tekrar denemede AYNI kimlik
  -- kullanilir, ayni faturaya ikinci yanit gitmez.
  `yanit_uuid`   char(36) DEFAULT NULL,
  `yanit_durum`  varchar(16) DEFAULT NULL COMMENT 'gonderiliyor | gonderildi | hata',
  `yanit_hata`   varchar(500) DEFAULT NULL,
  `yanit_at`     datetime DEFAULT NULL,
  `yanit_by`     int(11) DEFAULT NULL,

  -- Alisa aktarim: POS un kendi stok giris belgesi
  `document_id`  bigint(20) UNSIGNED DEFAULT NULL COMMENT 'inventory_documents.id',
  `supplier_id`  int(11) DEFAULT NULL,

  `xml`          longtext DEFAULT NULL,
  `created_at`   datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`   datetime DEFAULT NULL ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_gelen_ortam` (`client_id`,`ortam`,`uuid`),
  KEY `ix_gelen_tarih` (`client_id`,`ortam`,`belge_tarihi`),
  KEY `ix_gelen_bekleyen` (`client_id`,`ortam`,`senaryo`,`yanit`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- Ayni duzeltme gelen_belge icin. Ilk halde anahtar (client_id, uuid) idi:
-- testte cekilmis bir belge canliya gecildiginde yeniden cekilemezdi ve ayni
-- ETTN iki ortamda ayri yasayamazdi.
ALTER TABLE `gelen_belge` DROP INDEX IF EXISTS `uq_gelen`;
ALTER TABLE `gelen_belge`
  ADD UNIQUE KEY IF NOT EXISTS `uq_gelen_ortam` (`client_id`,`ortam`,`uuid`);
