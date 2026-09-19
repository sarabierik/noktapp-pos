-- ---------------------------------------------------------------------------
-- OKC kayit defteri ve kanit modeli  (2026-09-22)
--
-- Kaynak: Noktapp Turkish OKC integration, Version 1.0, 19 Eylul 2026.
--
-- NE OLDUGU. GIB'in yayinladigi Yeni Nesil OKC listesindeki cihazlarin
-- kaydi. Kasiyer cihazini bir metin kutusuna yazmaz; kendi cihazini bu
-- listeden secer. Secim mali fis prefixi ile dogrulanir.
--
-- NE OLMADIGI. Bu tablo bir UYUMLULUK LISTESI DEGILDIR. Bir cihazin burada
-- olmasi NOKTApp'in o cihazla konusabildigi anlamina gelmez. Uc ayri boyut
-- vardir ve hicbiri digerinin yerine gecmez:
--
--   registry_observation   GIB listesi ne diyor
--   documentation_access   gelistirici ne gorebiliyor
--   implementation_state   NOKTApp neyi KANITLADI
--
-- Bu yuzden her cihaz production_enabled = 0 ile baslar. Uretime acmak
-- ayri bir islemdir, kanit ister ve denetim kaydi birakir.
--
-- PREFIX ESLESTIRME. Prefix TEK BASINA ilk harften okunmaz: BCA ile BCM
-- farkli cihazlardir. Eslestirme en uzun prefixten baslar; belirsiz veya
-- taninmayan prefix uretim kaydinda REDDEDILIR.
--
-- CAKISMALAR SAKLANIR, COZULMEZ. Ayni donanimin iki mali sahibi altinda
-- gorunmesi (Ingenico iWE280/iDE280 hem PAVO hem Worldline) ayri kayitlar
-- olarak durur. Birini digerinin takma adi saymak yanlis olur.
-- ---------------------------------------------------------------------------

-- 1. Kayit defteri -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `fiscal_registry_devices` (
  `id`            int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `fiscal_owner`  varchar(160) NOT NULL   COMMENT 'Mali sahip - GIB kaydindaki tuzel kisi',
  `owner_key`     varchar(24)  NOT NULL   COMMENT 'Adaptor anahtari: token, hugin, pavo...',
  `brand_model`   varchar(160) NOT NULL,
  `prefix`        varchar(8)   NOT NULL   COMMENT 'Mali fis seri prefixi - RG, AS, BCA, YAB...',
  `fiscal_class`  enum('eft_pos','computer_connected') NOT NULL,
  `device_os`     varchar(120) DEFAULT NULL COMMENT 'GIB detay sayfasindaki donanim bilgisi. Kasiyer SDK isletim sistemi DEGILDIR',
  `category`      enum('retail','fuel_pump') NOT NULL DEFAULT 'retail',
  `evidence_kind` enum('live_register','pdf_only') NOT NULL DEFAULT 'live_register',
  `rollout_blocked` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = bu urunlerde hic teklif edilmez (akaryakit)',
  `note`          varchar(255) DEFAULT NULL COMMENT 'Acik kaynak cakismasi varsa burada durur',
  `created_at`    datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_prefix` (`prefix`),
  KEY `ix_owner` (`owner_key`,`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Yeniden calistirilabilir: prefix benzersiz, ayni satir tekrar yazilmaz.
INSERT INTO `fiscal_registry_devices`
  (`fiscal_owner`,`owner_key`,`brand_model`,`prefix`,`fiscal_class`,`device_os`,`category`,`evidence_kind`,`rollout_blocked`,`note`)
VALUES
-- VERA -----------------------------------------------------------------
('MT Bilgi Teknolojileri ve Dis Ticaret A.S.','vera','VERA Delta','RG','eft_pos','Secure Linux','retail','live_register',0,NULL),
('MT Bilgi Teknolojileri ve Dis Ticaret A.S.','vera','VERA Delta Plus','RJ','eft_pos','Secure Linux','retail','live_register',0,NULL),
-- TOKEN / BEKO ---------------------------------------------------------
('TOKEN Finansal Teknolojiler A.S.','token','BEKO 220 TR','AS','eft_pos','Linux','retail','live_register',0,NULL),
('TOKEN Finansal Teknolojiler A.S.','token','BEKO 300 TR','AT','eft_pos','Linux','retail','live_register',0,NULL),
('TOKEN Finansal Teknolojiler A.S.','token','BEKO X30 TR','AV','eft_pos','Android 11 Go','retail','live_register',0,NULL),
('TOKEN Finansal Teknolojiler A.S.','token','TOKEN T1 Pro','AY','eft_pos',NULL,'retail','live_register',0,'V04: harici SDK model matrisi dogrulanmadi'),
-- E DATA / PROPAY ------------------------------------------------------
('E DATA Elek. San. ve Tic. A.S.','edata','PROFILO VeriFone VX 680-E1','BCA','eft_pos','Linux','retail','live_register',0,NULL),
('E DATA Elek. San. ve Tic. A.S.','edata','FAREX FR-8300','BCB','computer_connected','Linux','retail','live_register',0,NULL),
('E DATA Elek. San. ve Tic. A.S.','edata','PROFILO YK-8200','BCD','computer_connected','Linux','retail','live_register',0,NULL),
('E DATA Elek. San. ve Tic. A.S.','edata','TELESTAR TLS-8100','BCE','computer_connected','Linux','retail','live_register',0,NULL),
('E DATA Elek. San. ve Tic. A.S.','edata','Profilo YK-PS300','BCF','computer_connected','Linux','retail','live_register',0,NULL),
('E DATA Elek. San. ve Tic. A.S.','edata','Profilo YK-7200M','BCG','computer_connected','Linux','retail','live_register',0,NULL),
('E DATA Elek. San. ve Tic. A.S.','edata','Telestar TLS-7100M','BCH','computer_connected','Linux','retail','live_register',0,NULL),
('E DATA Elek. San. ve Tic. A.S.','edata','TELEFUNKEN TFK-A1000','BCI','computer_connected','Linux','retail','live_register',0,NULL),
('E DATA Elek. San. ve Tic. A.S.','edata','PROFILO S900 ECR','BCJ','eft_pos',NULL,'retail','live_register',0,NULL),
('E DATA Elek. San. ve Tic. A.S.','edata','PROPAY P1000 ECR','BCM','eft_pos','Android 13','retail','live_register',0,'Prefix BCA ile karistirilmamali'),
-- HUGIN ----------------------------------------------------------------
('HUGIN Yazilim Teknolojileri A.S.','hugin','VERIFONE Vx675 ECR','FO','eft_pos','Verix QT650240','retail','live_register',0,NULL),
('HUGIN Yazilim Teknolojileri A.S.','hugin','HUGIN FT-202','FP','computer_connected','Linux 2.6','retail','live_register',0,NULL),
('HUGIN Yazilim Teknolojileri A.S.','hugin','HUGIN FP-300','FR','computer_connected','Linux 2.6','retail','live_register',0,NULL),
('HUGIN Yazilim Teknolojileri A.S.','hugin','HUGIN V10','FV','eft_pos',NULL,'retail','live_register',0,'V01: X900/FS ile ayni cihaz oldugu KANITLANMADI - ayri kayit'),
('HUGIN Yazilim Teknolojileri A.S.','hugin','HUGIN T300','FT','eft_pos',NULL,'retail','live_register',0,NULL),
('HUGIN Yazilim Teknolojileri A.S.','hugin','HUGIN S1','FU','eft_pos',NULL,'retail','live_register',0,NULL),
('HUGIN Yazilim Teknolojileri A.S.','hugin','HUGIN X900','FS','eft_pos',NULL,'retail','pdf_only',0,'V01: canli listede yok, yalnizca resmi PDF'),
-- PAVO -----------------------------------------------------------------
('PAVO Finansal Teknoloji Cozumleri A.S.','pavo','INGENICO iWE280','JH','eft_pos','Telium II','retail','live_register',0,'Ayni donanim Worldline altinda 2A prefixi ile ayrica kayitli'),
('PAVO Finansal Teknoloji Cozumleri A.S.','pavo','INGENICO iDE280','JI','eft_pos','Telium II','retail','live_register',0,'Ayni donanim Worldline altinda 2B prefixi ile ayrica kayitli'),
-- MIKROSARAY / inPOS ---------------------------------------------------
('MIKROSARAY Mikrobilgisayar Pazarlama ve Tic. A.S.','mikrosaray','MIKROSARAY Pidion MT360E','SC','eft_pos','Windows CE 6.0 CORE','retail','live_register',0,NULL),
('MIKROSARAY Mikrobilgisayar Pazarlama ve Tic. A.S.','mikrosaray','INFORMATIK inPOS m120','UB','eft_pos','inOS v2.0','retail','live_register',0,NULL),
('MIKROSARAY Mikrobilgisayar Pazarlama ve Tic. A.S.','mikrosaray','MIKROSARAY inpos m530','SD','eft_pos',NULL,'retail','live_register',0,NULL),
-- INFOTEKS / FUSIONS ---------------------------------------------------
('INFOTEKS Bil. Elk. Tele. Med. Rek. Ith. Ihr. San. ve Tic. Ltd. STI.','infoteks','FUSIONS 410G','OF','eft_pos','Windows CE 6.0 R3','retail','live_register',0,NULL),
-- WORLDLINE ------------------------------------------------------------
('WORLDLINE POS Teknoloji Cozum ve Servisleri A.S.','worldline','Ingenico ECR IWE280','2A','eft_pos','Telium II','retail','live_register',0,'PAVO JH ile ayni donanim, farkli mali sahip'),
('WORLDLINE POS Teknoloji Cozum ve Servisleri A.S.','worldline','Ingenico ECR iDE280','2B','eft_pos','Telium II','retail','live_register',0,'PAVO JI ile ayni donanim, farkli mali sahip'),
('WORLDLINE POS Teknoloji Cozum ve Servisleri A.S.','worldline','Ingenico MOVE5000F','2C','eft_pos','Tetra','retail','live_register',0,'Referans restoranda calisan cihaz'),
('WORLDLINE POS Teknoloji Cozum ve Servisleri A.S.','worldline','PAX A910SF','2D','eft_pos','Android','retail','live_register',0,NULL),
-- PANAROMA / OLIVETTI --------------------------------------------------
('PANAROMA Bil. Tek. San. ve Tic. A.S.','panaroma','OLIVETTI PBT 900-E','3A','computer_connected','Kernel 3.2.0','retail','live_register',0,NULL),
('PANAROMA Bil. Tek. San. ve Tic. A.S.','panaroma','OLIVETTI PBT 900-G','3B','computer_connected','Kernel 3.2.0','retail','live_register',0,NULL),
('PANAROMA Bil. Tek. San. ve Tic. A.S.','panaroma','OLIVETTI PBT 900-P','3C','computer_connected','Kernel 3.2.0','retail','live_register',0,NULL),
('PANAROMA Bil. Tek. San. ve Tic. A.S.','panaroma','OLIVETTI PBT 990-E','3D','computer_connected','Kernel 3.2.0','retail','live_register',0,NULL),
('PANAROMA Bil. Tek. San. ve Tic. A.S.','panaroma','OLIVETTI VERIFONE MX 915 ECR','3E','eft_pos','Linux','retail','live_register',0,NULL),
('PANAROMA Bil. Tek. San. ve Tic. A.S.','panaroma','VERIFONE MX 915 ECR-C','3F','eft_pos','Linux','retail','live_register',0,NULL),
('PANAROMA Bil. Tek. San. ve Tic. A.S.','panaroma','VERIFONE VX680 ECR','3G','eft_pos','Linux','retail','live_register',0,NULL),
-- ENPOS ----------------------------------------------------------------
('ENPOS Bilisim Sanayi ve Ticaret A.S.','enpos','N-POS YN-200','PC','computer_connected','Windows Embedded / PosReady 7','retail','live_register',0,NULL),
('ENPOS Bilisim Sanayi ve Ticaret A.S.','enpos','N-POS YN-100','PD','computer_connected','Windows Embedded / PosReady 7','retail','live_register',0,NULL),
('ENPOS Bilisim Sanayi ve Ticaret A.S.','enpos','N-POS YN-101','PE','computer_connected','Windows Embedded / PosReady 7','retail','live_register',0,NULL),
('ENPOS Bilisim Sanayi ve Ticaret A.S.','enpos','N-POS YN500','PF','computer_connected',NULL,'retail','live_register',0,NULL),
-- NCR ------------------------------------------------------------------
('NCR Bilisim Sistemleri Ltd. Sti.','ncr','NCR E10','TU','computer_connected','Linux','retail','live_register',0,NULL),
('NCR Bilisim Sistemleri Ltd. Sti.','ncr','NCR E10-7197','TV','computer_connected','Linux','retail','live_register',0,NULL),
('NCR Bilisim Sistemleri Ltd. Sti.','ncr','NCR E10-7199','TY','computer_connected','Linux','retail','live_register',0,NULL),
('NCR Bilisim Sistemleri Ltd. Sti.','ncr','NCR ENC-2020','TZ','computer_connected','Linux','retail','live_register',0,NULL),
-- TOSHIBA --------------------------------------------------------------
('TOSHIBA Global Commerce Solutions Turkey Teknoloji A.S.','toshiba','TOSHIBA 4610-2NF','YAB','computer_connected','Linux tabanli 32 bit','retail','live_register',0,NULL),
('TOSHIBA Global Commerce Solutions Turkey Teknoloji A.S.','toshiba','TOSHIBA 6145-1TF','YAC','computer_connected',NULL,'retail','live_register',0,'V-not: kayit ve detay YAC diyor, devreye alirken seri dogrulanmali'),
-- PAYPORT --------------------------------------------------------------
('PAYPORT Bilisim Tek. San. ve Dis Ticaret Ltd. Sti.','payport','PAYPORT PR-810','4A','computer_connected','Embedded Linux','retail','live_register',0,NULL),
-- PAYGO ----------------------------------------------------------------
('PAYGO Finansal Teknoloji Hizmetleri A.S.','paygo','PAYGO SP630PRO ECR','5B','eft_pos','Linux','retail','live_register',0,NULL),
('PAYGO Finansal Teknoloji Hizmetleri A.S.','paygo','PAYGO N950S ECR','5C','eft_pos',NULL,'retail','live_register',0,'V02: canli listede var, onayli cihazlar PDF de yok'),
-- PAYERA ---------------------------------------------------------------
('PAYERA Finansal Teknoloji Cozumleri A.S.','payera','PAYERA P10','6A','eft_pos','Android 10','retail','live_register',0,'V12: portal sozlesmesi P10 mali akisini kapsiyor mu belirsiz'),
-- AKARYAKIT - ayri alan, bu urunlerde teklif edilmez ---------------------
('TOKEN Finansal Teknolojiler A.S.','token','BEKO 1000TR','AU','eft_pos',NULL,'fuel_pump','live_register',1,'Akaryakit - ayri sartname gerekir'),
('TURPAK','turpak','TURPAK VISION','DK','eft_pos',NULL,'fuel_pump','live_register',1,'Akaryakit - ayri sartname gerekir'),
('MEPSAN','mepsan','MEPSAN PCR 172','IF','eft_pos',NULL,'fuel_pump','live_register',1,'Akaryakit - ayri sartname gerekir'),
('E DATA Elek. San. ve Tic. A.S.','edata','PROFILO PYK-9000','BCK','eft_pos',NULL,'fuel_pump','live_register',1,'Akaryakit - ayri sartname gerekir'),
('E DATA Elek. San. ve Tic. A.S.','edata','PROPAY PYK-9000','BCL','eft_pos',NULL,'fuel_pump','live_register',1,'Akaryakit - ayri sartname gerekir')
ON DUPLICATE KEY UPDATE
  `fiscal_owner`=VALUES(`fiscal_owner`), `owner_key`=VALUES(`owner_key`),
  `brand_model`=VALUES(`brand_model`), `fiscal_class`=VALUES(`fiscal_class`),
  `device_os`=VALUES(`device_os`), `category`=VALUES(`category`),
  `evidence_kind`=VALUES(`evidence_kind`), `rollout_blocked`=VALUES(`rollout_blocked`),
  `note`=VALUES(`note`);


-- 2. Devreye alinan cihaza kayit defteri kimligi ----------------------------
--
-- fiscal_devices zaten var (provider, serial_number, environment...). Yerine
-- yenisi yazilmaz; uzerine kanit alanlari eklenir.
ALTER TABLE `fiscal_devices`
  ADD COLUMN IF NOT EXISTS `registry_device_id` int(10) UNSIGNED DEFAULT NULL
    COMMENT 'fiscal_registry_devices.id - kasiyerin listeden sectigi gercek cihaz' AFTER `provider`,
  ADD COLUMN IF NOT EXISTS `fiscal_prefix` varchar(8) DEFAULT NULL
    COMMENT 'Mali seriden cikarilan normal prefix' AFTER `registry_device_id`,
  ADD COLUMN IF NOT EXISTS `serial_raw` varchar(64) DEFAULT NULL
    COMMENT 'Seri NUMARASI ham haliyle - normalize edilmis hali serial_number' AFTER `serial_number`,
  ADD COLUMN IF NOT EXISTS `production_enabled` tinyint(1) NOT NULL DEFAULT 0
    COMMENT '0 = mali islem yapilamaz. Acmak ayri, denetlenen bir islemdir' AFTER `is_active`,
  ADD COLUMN IF NOT EXISTS `production_enabled_at` datetime DEFAULT NULL AFTER `production_enabled`,
  ADD COLUMN IF NOT EXISTS `production_enabled_by` int(11) DEFAULT NULL AFTER `production_enabled_at`,
  ADD COLUMN IF NOT EXISTS `adapter_version` varchar(40) DEFAULT NULL AFTER `production_enabled_by`,
  ADD COLUMN IF NOT EXISTS `firmware_version` varchar(64) DEFAULT NULL AFTER `adapter_version`,
  ADD COLUMN IF NOT EXISTS `integration_app_version` varchar(64) DEFAULT NULL AFTER `firmware_version`,
  ADD COLUMN IF NOT EXISTS `config_fingerprint` char(64) DEFAULT NULL
    COMMENT 'Yetenek kanitinin hangi yapilandirmaya ait oldugu' AFTER `integration_app_version`,
  ADD COLUMN IF NOT EXISTS `quarantine_reason` varchar(190) DEFAULT NULL
    COMMENT 'Dolu ise cihaz mali islem almaz - cozulmemis islem var' AFTER `status_detail`;

-- 3. Yetenek profili ---------------------------------------------------------
--
-- "Bu marka iade destekler" cok genis bir cumledir. Yetenek; mali sahip +
-- model + firmware + entegrasyon uygulamasi + SDK + tasima + banka
-- uygulamasi birlesimine aittir.
--
-- UNKNOWN mali icrada KAPALI TARAFA duser. Yoklugu degil, bilinmezligi
-- ifade eder ve bu yuzden islem reddedilir.
CREATE TABLE IF NOT EXISTS `fiscal_device_capabilities` (
  `id`               int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`        int(11) NOT NULL,
  `fiscal_device_id` int(10) UNSIGNED NOT NULL,
  `capability`       varchar(40) NOT NULL COMMENT 'basketSale, cardCollection, mixedTender, refundAndVoid...',
  `state`            enum('VERIFIED','UNSUPPORTED','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  `evidence_ref`     varchar(255) DEFAULT NULL COMMENT 'Sozlesme, test raporu, uretici yazisi',
  `tested_at`        datetime DEFAULT NULL,
  `config_fingerprint` char(64) DEFAULT NULL,
  `limits_json`      longtext DEFAULT NULL CHECK (json_valid(`limits_json`) OR `limits_json` IS NULL),
  `operator_requirements` varchar(255) DEFAULT NULL,
  `updated_at`       datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cap` (`fiscal_device_id`,`capability`),
  KEY `ix_cap_state` (`client_id`,`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Islem, deneme, kanit, giden kutusu --------------------------------------
--
-- Sartnamedeki PostgreSQL tasarimi MariaDB'ye uyarlandi. Onemli olan
-- turler degil, SINIRLAR: idempotency benzersizligi, degismez niyet
-- anlik goruntusu, cihaz basina artan fencing jetonu, ve kanitin
-- yalnizca eklenebilir olmasi.
CREATE TABLE IF NOT EXISTS `fiscal_operations` (
  `id`                char(36) NOT NULL,
  `client_id`         int(11) NOT NULL,
  `branch_id`         int(11) DEFAULT NULL,
  `fiscal_device_id`  int(10) UNSIGNED DEFAULT NULL,
  `business_sale_id`  varchar(64) NOT NULL COMMENT 'Adisyon/folio - urun tarafindaki satis',
  `business_revision` varchar(40) NOT NULL,
  `idempotency_key`   varchar(120) NOT NULL,
  `payload_hash`      char(64) NOT NULL COMMENT 'Donmus niyetin ozeti - ayni anahtar farkli govde = 409',
  `intent_json`       longtext NOT NULL CHECK (json_valid(`intent_json`)),
  `workflow`          enum('SALE','ADVANCE_COLLECTION','INVOICE_COLLECTION','REFUND') NOT NULL DEFAULT 'SALE',
  `orchestration_state` enum('CREATED','VALIDATED','QUEUED','DISPATCHING','WAITING','RECOVERY_REQUIRED','CLOSED') NOT NULL DEFAULT 'CREATED',
  `payment_state`     enum('NOT_STARTED','PENDING','PARTIAL','CONFIRMED','DECLINED','REVERSED','UNKNOWN') NOT NULL DEFAULT 'NOT_STARTED',
  `document_state`    enum('NOT_STARTED','OPEN','CONFIRMED','CANCELLED','UNKNOWN') NOT NULL DEFAULT 'NOT_STARTED',
  `sync_state`        enum('LOCAL_ONLY','CENTRAL_ACKNOWLEDGED','CONFLICT') NOT NULL DEFAULT 'LOCAL_ONLY',
  `next_recovery_action` varchar(80) DEFAULT NULL,
  `recovery_contract_version` varchar(40) DEFAULT NULL,
  `requires_operator` tinyint(1) NOT NULL DEFAULT 0,
  `last_evidence_at`  datetime DEFAULT NULL,
  `version`           bigint(20) NOT NULL DEFAULT 0,
  `created_at`        datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`        datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_idem` (`client_id`,`idempotency_key`),
  KEY `ix_open` (`client_id`,`orchestration_state`),
  KEY `ix_sale` (`client_id`,`business_sale_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `fiscal_attempts` (
  `id`               char(36) NOT NULL,
  `operation_id`     char(36) NOT NULL,
  `client_id`        int(11) NOT NULL,
  `action_kind`      varchar(40) NOT NULL COMMENT 'sale, cancel, refund, query, resume',
  `fiscal_device_id` int(10) UNSIGNED NOT NULL,
  `fencing_token`    bigint(20) NOT NULL COMMENT 'Cihaz basina monoton artar - eski sahip reddedilir',
  `adapter_version`  varchar(40) NOT NULL,
  `prepared_payload_hash` char(64) NOT NULL,
  `dispatch_state`   enum('PREPARED','SENT','OBSERVED','ABANDONED') NOT NULL DEFAULT 'PREPARED',
  `vendor_document_ref` varchar(120) DEFAULT NULL,
  `vendor_payment_ref`  varchar(120) DEFAULT NULL,
  `recorded_at`      datetime NOT NULL DEFAULT current_timestamp(),
  `last_observed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_op` (`operation_id`),
  KEY `ix_dev_fence` (`fiscal_device_id`,`fencing_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `fiscal_evidence` (
  `id`            char(36) NOT NULL,
  `operation_id`  char(36) DEFAULT NULL,
  `attempt_id`    char(36) DEFAULT NULL,
  `client_id`     int(11) NOT NULL,
  `source_scope`  varchar(40) NOT NULL COMMENT 'adapter:token, callback:hugin, operator...',
  `dedupe_key`    varchar(190) NOT NULL COMMENT 'Ayni kanit iki kez gelirse tek kez uygulanir',
  `payload_hash`  char(64) NOT NULL,
  `event_class`   enum('DISPATCH_ACCEPTED','PAYMENT_CONFIRMED','PAYMENT_DECLINED','DOCUMENT_CONFIRMED','REVERSAL_CONFIRMED','STATE_OBSERVED','OPERATOR_ACTION_REQUIRED') NOT NULL,
  `redacted_payload` longtext DEFAULT NULL CHECK (json_valid(`redacted_payload`) OR `redacted_payload` IS NULL),
  `observed_at`   datetime DEFAULT NULL COMMENT 'Saticinin soyledigi zaman',
  `received_at`   datetime NOT NULL DEFAULT current_timestamp() COMMENT 'Bizim aldigimiz zaman - ayri tutulur',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dedupe` (`client_id`,`source_scope`,`dedupe_key`),
  KEY `ix_ev_op` (`operation_id`,`received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `fiscal_outbox` (
  `id`             bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_id`       char(36) NOT NULL,
  `client_id`      int(11) NOT NULL,
  `operation_id`   char(36) NOT NULL,
  `event_type`     varchar(60) NOT NULL,
  `schema_version` int(11) NOT NULL DEFAULT 1,
  `payload`        longtext NOT NULL CHECK (json_valid(`payload`)),
  `created_at`     datetime NOT NULL DEFAULT current_timestamp(),
  `published_at`   datetime DEFAULT NULL,
  `delivery_attempts` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event` (`event_id`),
  KEY `ix_cursor` (`client_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. Cihaz sahipligi ve kiralama ---------------------------------------------
CREATE TABLE IF NOT EXISTS `fiscal_device_ownership` (
  `fiscal_device_id` int(10) UNSIGNED NOT NULL,
  `client_id`        int(11) NOT NULL,
  `owner_agent`      varchar(64) DEFAULT NULL,
  `lease_expires_at` datetime DEFAULT NULL,
  `fencing_sequence` bigint(20) NOT NULL DEFAULT 0,
  `quarantine_reason` varchar(190) DEFAULT NULL,
  `updated_at`       datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`fiscal_device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
