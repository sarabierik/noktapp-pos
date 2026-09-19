-- ---------------------------------------------------------------------------
-- Inceleme kodu  (2026-09-21)
--
-- Normal eslestirme kodu ON DAKIKA yasar ve BIR KEZ kullanilir. Garson
-- yanindayken bu dogrudur: kod ekranda, telefon elde, is biter.
--
-- Google Play'in inceleme ekibi icin dogru degildir. Basvuruyu gonderirsiniz,
-- inceleyen kisi ertesi sabah uygulamayi acar, kod coktan olmustur ve
-- basvuru "App access" maddesinden reddedilir. Ayni sey bir bayiye uzaktan
-- kurulum yaptirirken de olur.
--
-- Bu yuzden ikinci bir kod turu:
--
--   reusable = 1   Kod kullanildiktan sonra OLMEZ. Birden fazla telefon,
--                  ayni kodla, suresi dolana kadar baglanabilir.
--   use_count      Kac kere kullanildi. Ekranda gorunur; beklemediginiz bir
--                  sayi gorurseniz kodu iptal edersiniz.
--   label          Kod ne icin uretildi ("Google inceleme", "Bayi kurulumu").
--                  Ayarlar ekraninda bu yazi gorunur.
--
-- GUVENLIK. Bu kod, suresi boyunca acik duran bir kapidir. Bu yuzden:
--   * yalnizca user.manage yetkisi olan kullanici uretebilir,
--   * MUTLAKA bir personele bagli uretilir - telefon o personelin yetkisini
--     alir, kasanin yetkisini degil,
--   * en fazla 30 gun,
--   * Ayarlar > Cihazlar ekraninda sarı bir uyari ile gorunur ve tek tikla
--     iptal edilir.
-- Inceleme bitince IPTAL EDIN.
-- ---------------------------------------------------------------------------

ALTER TABLE `np_mobile_pairings`
  ADD COLUMN IF NOT EXISTS `reusable` tinyint(1) NOT NULL DEFAULT 0
    COMMENT '1 = kod kullanilinca olmez, suresi dolana kadar tekrar kullanilir' AFTER `redeemed_by`,
  ADD COLUMN IF NOT EXISTS `use_count` int(11) NOT NULL DEFAULT 0
    COMMENT 'Kac telefon bu kodla baglandi' AFTER `reusable`,
  ADD COLUMN IF NOT EXISTS `label` varchar(40) DEFAULT NULL
    COMMENT 'Kod ne icin uretildi - Ayarlar ekraninda gorunur' AFTER `use_count`;
