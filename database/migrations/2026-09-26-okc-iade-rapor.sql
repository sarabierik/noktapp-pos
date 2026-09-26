-- ---------------------------------------------------------------------------
-- OKC: iade referanslari, rapor kaydi ve cihaz ayar anlik goruntusu
-- (2026-09-26)
--
-- Uc ayri eksik kapatiliyor. Ucu de "kod yazilmis ama veri hicbir yere
-- yazilmiyor" turunden; bu yuzden hicbiri ekranda hata olarak gorunmuyordu.
--
-- 1. IADE REFERANSLARI. HUGIN PC Link iadeyi POST /v1/pos/refunds ile alir ve
--    govdede bankId + bankReferenceNo ister. Bu iki alan YALNIZCA orijinal
--    satisin detayli yanitinda gelir ve sonradan cihazdan sorgulanamaz.
--    Simdiye kadar yalnizca fiscal_receipts.raw_response icindeki JSON'a
--    dusuyorlardi: orada olmalari kayit degil kazadir - alan adi degisirse
--    veya yanit kirpilirsa iade imkani temelli kaybolur. Kendi kolonlarina
--    aliniyorlar.
--
-- 2. RAPOR KAYDI. fiscal_device_reports.report_key NOT NULL ve
--    (client_id, report_key) UNIQUE. deviceReport() bu kolonu hic
--    doldurmuyordu ve INSERT .catch(() => {}) ile yutuluyordu: alinan her X
--    ve Z raporu sessizce kayitsiz kaliyordu. Kolonun kendisi dogru; yanlis
--    olan yazan taraf (kodda duzeltildi). Burada yalnizca eski satirlar icin
--    aranabilir bir indeks ve rapor turu genisletmesi var.
--
-- 3. CIHAZ AYAR ANLIK GORUNTUSU. Eslesmede GET /v1/settings cihazin kendi
--    ayarlarini dondurur ve adapter bunu zaten `settings` olarak geri
--    veriyor - rota onu atiyordu. Ham haliyle saklaniyor. Tahmin edilen bir
--    kolon semasi YOK: hangi anahtarlarin geldigini cihaz soyler, biz
--    uydurmayiz. Mali lisans bitis tarihi de bu anlik goruntude gelir ve
--    kayit defteri ekrani onu oradan okur.
-- ---------------------------------------------------------------------------

-- 1 -------------------------------------------------------------------------
ALTER TABLE `fiscal_transactions`
  ADD COLUMN IF NOT EXISTS `bank_id` varchar(24) DEFAULT NULL
    COMMENT 'PC Link iadesi icin: orijinal satisin detayli yanitindaki bankId'
    AFTER `provider_transaction_id`,
  ADD COLUMN IF NOT EXISTS `bank_reference_no` varchar(64) DEFAULT NULL
    COMMENT 'PC Link iadesi icin: bankReferenceNo. Sonradan sorgulanamaz'
    AFTER `bank_id`,
  ADD COLUMN IF NOT EXISTS `pos_transaction_id` varchar(64) DEFAULT NULL
    COMMENT 'Banka islem numarasi - gun sonu ONCESI iptal (void) bununla yapilir'
    AFTER `bank_reference_no`;

-- Iade edilebilir islemleri bulmak icin: referansi olan, onaylanmis satislar.
ALTER TABLE `fiscal_transactions`
  ADD KEY IF NOT EXISTS `ix_refundable` (`client_id`,`state`,`bank_reference_no`);

-- 2 -------------------------------------------------------------------------
-- X/Z raporlarini cihaz ve tarihe gore aramak icin. report_type zaten var.
ALTER TABLE `fiscal_device_reports`
  ADD KEY IF NOT EXISTS `ix_report_type_time` (`client_id`,`report_type`,`created_at`);

-- 3 -------------------------------------------------------------------------
ALTER TABLE `fiscal_devices`
  ADD COLUMN IF NOT EXISTS `pclink_settings_json` longtext DEFAULT NULL
    COMMENT 'Eslesmede GET /v1/settings ne dondurduyse - ham, yorumlanmamis'
    AFTER `pclink_sfa_version`,
  ADD COLUMN IF NOT EXISTS `pclink_settings_at` datetime DEFAULT NULL
    COMMENT 'Anlik goruntunun alindigi an. Cihaz ayarlari degisebilir'
    AFTER `pclink_settings_json`;

-- 4. Fis satir limiti: "kimse girmedi" ile "40 girildi" ayrilliyor -----------
--
-- max_sale_lines NOT NULL DEFAULT 40 idi. 40 sayisi INGENICO GMP-3'un
-- belgelenmis degeri; kolon defaulti oldugu icin HUGIN dahil her cihaza da
-- yaziliyordu. Sonuc: 45 satirlik bir adisyon, cihaz kabul edebilecek olsa
-- bile kasa tarafindan reddediliyordu ve kasiyere "adisyonu bolun" deniyordu.
--
-- Kolon NULL kabul ediyor hale getiriliyor. NULL = "kimse bir limit
-- girmedi", ve bu durumda limiti adaptorun kendi protokolu soyler
-- (GMP-3: 40, PC Link: belgede sayi yok -> limit uygulanmaz).
ALTER TABLE `fiscal_devices`
  MODIFY COLUMN `max_sale_lines` smallint(5) UNSIGNED DEFAULT NULL
    COMMENT 'Operatorun cihaz el kitabindan girdigi satir limiti. NULL = girilmedi, adaptor belirler';

-- Yalnizca hic girilmemis olanlar temizlenir: HUGIN cihazlarinda duran 40,
-- bir insanin karari degil kolon defaultidir. Ingenico/GMP-3 kayitlarina
-- DOKUNULMAZ - orada 40 dogru sayi.
-- DIKKAT: burada LOWER() KULLANILMAZ. Bu semanin collation'i utf8mb4_turkish_ci
-- ve LOWER('SIMULATOR') Turkce'de 'sImulator' -> 'sımulator' (noktasiz i) verir;
-- bu da 'simulator' ile ESLESMEZ. Ayni tuzak daha once gercek mali fis tutan bir
-- cihazin silinmesine yol acacak bir karsilastirmada bulundu. Adaptor anahtarlari
-- kod tarafinda kucuk harfle yazilir; karsilastirma ikili (bin) collation ile,
-- yazildigi haliyle yapilir.
UPDATE `fiscal_devices`
   SET `max_sale_lines` = NULL
 WHERE `max_sale_lines` = 40
   AND `provider` COLLATE utf8mb4_bin IN ('hugin', 'simulator');
