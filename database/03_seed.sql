-- =====================================================================
--  NOKTApp POS - FIRST RUN SEED
--  Runs once, right after the setup wizard activates the licence.
--  NOTE: there is NO default user and NO default password. The first
--  user row is written from the licence/activation response.
--  :client_id is substituted by the installer/service at run time.
-- =====================================================================
SET NAMES utf8mb4;

INSERT INTO `np_relay_state` (`id`,`last_msg_id`) VALUES (1,0)
  ON DUPLICATE KEY UPDATE `id`=1;

INSERT INTO `np_display_settings` (`id`,`template`,`headline`,`subline`,`enabled`)
VALUES (1,'marka','Hos geldiniz','Afiyet olsun',0)
  ON DUPLICATE KEY UPDATE `id`=1;

INSERT INTO `np_settings` (`k`,`v`) VALUES
  ('service_port','7451'),
  ('lan_enabled','1'),
  ('relay_enabled','1'),
  ('panel_url','https://pos.noktapp.com'),
  ('backup_local_every_min','15'),
  ('backup_cloud_hour','3'),
  ('backup_keep_days','14'),
  ('receipt_width','48'),
  ('currency','TRY'),
  ('business_day_start','06:00'),
  ('fiscal_enabled','0'),
  ('fiscal_provider','simulator'),
  ('setup_done','0')
ON DUPLICATE KEY UPDATE `v`=VALUES(`v`);

-- Default service structure for a brand new restaurant --------------
INSERT INTO `stations` (`client_id`,`name`,`display_name`,`is_default`,`is_active`,`sort_order`) VALUES
  (:client_id,'Kasa','Kasa / Adisyon',1,1,1),
  (:client_id,'Mutfak','Mutfak',0,1,2),
  (:client_id,'Bar','Bar',0,1,3);

INSERT INTO `table_zones` (`client_id`,`name`,`sort_order`,`is_active`) VALUES
  (:client_id,'Salon',1,1),
  (:client_id,'Bahce',2,1);

INSERT INTO `cash_registers` (`client_id`,`branch_id`,`name`,`code`,`is_active`,`created_at`)
VALUES (:client_id,1,'Kasa 1','KASA1',1,NOW());

INSERT INTO `pricing_strategy` (`client_id`,`mode`,`set_at`,`set_by`) VALUES (:client_id,'profit',NOW(),0);

INSERT INTO `inventory_units` (`client_id`,`name`,`created_at`)
SELECT :client_id, n, NOW() FROM (
  SELECT 'Adet' n UNION ALL SELECT 'Kilogram' UNION ALL SELECT 'Gram' UNION ALL
  SELECT 'Litre' UNION ALL SELECT 'Mililitre' UNION ALL SELECT 'Paket'
) u;

INSERT INTO `order_counters` (`client_id`,`last_no`)
SELECT :client_id, 0 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `order_counters` WHERE `client_id`=:client_id);

INSERT INTO `app_order_counters` (`client_id`,`business_date`,`prefix`,`next_no`)
VALUES (:client_id, CURDATE(), 1, 1)
ON DUPLICATE KEY UPDATE `next_no`=`next_no`;
