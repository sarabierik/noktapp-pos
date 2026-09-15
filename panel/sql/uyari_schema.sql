-- =====================================================================
--  NOKTApp POS - UYARILAR (alerts)
--
--  WHAT: the rules the hourly cron evaluates, and the record of what has
--  already been sent so that it is not sent again.
--
--  WHY np_alert_sent is the whole feature
--  --------------------------------------
--  Evaluating "this licence expires in seven days" is four lines of SQL.
--  Any cron that only does that mails the same sentence every hour for a
--  week - 168 identical e-mails about one customer - and the owner turns
--  the alerts off, after which they protect nothing at all. The unique
--  key below is what makes an alert an alert rather than a nuisance.
--
--  WHY subject_key is an EPISODE and not a rule name
--  -------------------------------------------------
--  UNIQUE(rule_id, tenant_id, subject_key) has to answer two questions
--  at once: "have I already said this" (never say it twice) and "is this
--  a NEW occurrence of the same kind of trouble" (say it again, because
--  it is news). So subject_key names the OCCASION, not the rule:
--
--    licence_expiring  the licence's own expires_at date. Renew the
--                      licence and the date moves, so the next time it
--                      comes close to expiry it alerts again - and until
--                      it is renewed, it stays silent.
--    till_silent       the till plus the moment it was last heard from.
--                      A till that comes back and later goes quiet again
--                      has a different "last seen", so it is a different
--                      episode and alerts again.
--    backup_missing    the tenant plus the date of the last backup we
--                      hold ("hic" when there has never been one). A
--                      backup arriving ends the episode; the next gap
--                      after it is a new one.
--    day_not_closed    the tenant plus the date of the last day-end we
--                      hold ("hic" when none has ever arrived). The till
--                      is demonstrably online - that is what separates
--                      this from till_silent - and nobody is closing the
--                      day. One day-end ends the episode.
--
--  This is why nothing here stores a "resolved" flag and why nothing
--  ever deletes from this table: the key already carries the difference
--  between a repeat and a recurrence, and a row that was deleted to
--  "reset" an alert is a row that lets the same alert be sent twice.
--
--  WHY channel exists while only e-mail is implemented
--  ---------------------------------------------------
--  The column is where WhatsApp goes if the owner ever chooses a
--  provider. Building an integration against a provider nobody has
--  chosen is how you end up maintaining two of them. Anything that is
--  not 'email' is skipped by lib/uyari.php and said so on screen.
--
--  np_settings is a plain key/value store for the panel's own settings.
--  It holds, among other things, the cron secret. The secret lives in
--  the DATABASE and not in lib/config.php because config.php is never
--  edited on a live panel (it holds live credentials and is excluded
--  from the release package), and the owner has to be able to roll the
--  key from a screen when it leaks.
--
--  Guarded throughout, so admin/guncelle.php can apply it to a live
--  panel and applying it twice is harmless. The four rules are seeded
--  per KIND and only when that kind is missing, so an owner who has
--  changed a threshold keeps his threshold across updates.
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `np_settings` (
  `k` varchar(64) NOT NULL,
  `v` text DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_alert_rules` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `kind` varchar(32) NOT NULL,
  -- Days, in every rule that has one. licence_expiring: how far ahead to
  -- look. till_silent / backup_missing / day_not_closed: how long the
  -- thing may be missing before it is worth an e-mail.
  `threshold` int(11) NOT NULL DEFAULT 7,
  `channel` varchar(16) NOT NULL DEFAULT 'email',
  -- Empty means "the administrators in np_admins". A single address here
  -- overrides that, so the owner can send the money alerts to himself and
  -- the technical ones to whoever answers the phone.
  `target` varchar(190) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `ix_rule_kind` (`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_alert_sent` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `rule_id` int(11) NOT NULL,
  `tenant_id` int(11) NOT NULL,
  `subject_key` varchar(120) NOT NULL,
  `sent_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_alert_once` (`rule_id`,`tenant_id`,`subject_key`),
  KEY `ix_alert_when` (`sent_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `np_alert_rules` (`kind`,`threshold`,`channel`,`target`,`is_active`)
SELECT 'licence_expiring', 7, 'email', NULL, 1 FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM `np_alert_rules` WHERE `kind`='licence_expiring');

INSERT INTO `np_alert_rules` (`kind`,`threshold`,`channel`,`target`,`is_active`)
SELECT 'till_silent', 3, 'email', NULL, 1 FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM `np_alert_rules` WHERE `kind`='till_silent');

INSERT INTO `np_alert_rules` (`kind`,`threshold`,`channel`,`target`,`is_active`)
SELECT 'backup_missing', 2, 'email', NULL, 1 FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM `np_alert_rules` WHERE `kind`='backup_missing');

INSERT INTO `np_alert_rules` (`kind`,`threshold`,`channel`,`target`,`is_active`)
SELECT 'day_not_closed', 2, 'email', NULL, 1 FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM `np_alert_rules` WHERE `kind`='day_not_closed');
