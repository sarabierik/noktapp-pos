<?php
/**
 * The four tables the guest side added to the shared loyalty database.
 *
 * One file, because two very different callers need the same shapes and the one
 * thing worse than an unmigrated table is two files disagreeing about its
 * columns: api/desktop/sync.php WRITES the mirror when a till pushes, and
 * api/guest/* READS it when a phone asks. If the reader's idea of the schema
 * drifts from the writer's, the symptom is an empty screen for a guest who has
 * stamps — which is the exact bug this whole chain was built to fix.
 *
 * Created on demand rather than assumed, because a panel is updated by copying
 * files over FTP and there is no migration runner on the hosting account. A
 * restaurant must not go dark over a table nobody remembered to add. MariaDB
 * answers CREATE TABLE IF NOT EXISTS out of its own dictionary, and the static
 * guard means one call per request at most.
 *
 * Why these are not the product's own loyalty_programs and loyalty_events:
 * both of those auto-increment per database, and the desktop tills each have
 * their own. Every restaurant we have ever sold to has a programme 1 and an
 * event 41. Writing a till's local id into a table keyed by that id alone would
 * let one restaurant's campaign land on another's, silently, with the guest's
 * card still pointing at the row. So the mirror is keyed by the pair that is
 * genuinely unique: the tenant plus the till's own id.
 */

function pass_ensure_tables(PDO $pass): void {
    static $done = false;
    if ($done) return;

    /* Campaign definitions mirrored up from the tills. */
    $pass->exec(
        "CREATE TABLE IF NOT EXISTS `np_tenant_programs` (
           `tenant_id`     int(11) NOT NULL,
           `program_id`    int(10) UNSIGNED NOT NULL,
           `product_id`    int(10) UNSIGNED DEFAULT NULL,
           `title`         varchar(190) NOT NULL,
           `target_count`  int(10) UNSIGNED NOT NULL DEFAULT 10,
           `reward_text`   varchar(190) NOT NULL,
           `product_name`  varchar(190) DEFAULT NULL,
           `product_price` decimal(10,2) DEFAULT NULL,
           `is_active`     tinyint(1) NOT NULL DEFAULT 1,
           `updated_at`    datetime NOT NULL DEFAULT current_timestamp()
                           ON UPDATE current_timestamp(),
           PRIMARY KEY (`tenant_id`,`program_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    /* The guest's own movements, mirrored up with the balances. */
    $pass->exec(
        "CREATE TABLE IF NOT EXISTS `np_guest_events` (
           `tenant_id`     int(11) NOT NULL,
           `event_id`      bigint(20) UNSIGNED NOT NULL,
           `customer_id`   int(10) UNSIGNED NOT NULL,
           `program_id`    int(10) UNSIGNED NOT NULL,
           `card_id`       int(10) UNSIGNED DEFAULT NULL,
           `kind`          enum('stamp','reward','adjust') NOT NULL DEFAULT 'stamp',
           `qty`           int(11) NOT NULL DEFAULT 1,
           `order_id`      int(10) UNSIGNED DEFAULT NULL,
           `product_name`  varchar(190) DEFAULT NULL,
           `program_title` varchar(190) DEFAULT NULL,
           `happened_at`   datetime NOT NULL,
           `mirrored_at`   datetime NOT NULL DEFAULT current_timestamp(),
           PRIMARY KEY (`tenant_id`,`event_id`),
           KEY `ix_guest` (`customer_id`,`happened_at`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    /* A phone's session. token_hash, never the token: a session row is a bearer
       credential, so a database dump that contained them would log an attacker
       in as every guest at once. */
    $pass->exec(
        "CREATE TABLE IF NOT EXISTS `np_guest_sessions` (
           `token_hash`   char(64) NOT NULL,
           `customer_id`  int(10) UNSIGNED NOT NULL,
           `device_label` varchar(120) DEFAULT NULL,
           `created_at`   datetime NOT NULL DEFAULT current_timestamp(),
           `last_seen_at` datetime NOT NULL DEFAULT current_timestamp(),
           `expires_at`   datetime NOT NULL,
           PRIMARY KEY (`token_hash`),
           KEY `ix_customer` (`customer_id`),
           KEY `ix_expiry` (`expires_at`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    /* Failed attempts, for the throttles. Kept in the shared database rather
       than the panel's np_login_attempts because a guest is not a tenant and
       the two rate limits must not share a bucket. */
    $pass->exec(
        "CREATE TABLE IF NOT EXISTS `np_guest_attempts` (
           `id`         bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
           `bucket`     varchar(32) NOT NULL,
           `ident`      varchar(120) NOT NULL,
           `ip`         varchar(64) DEFAULT NULL,
           `ok`         tinyint(1) NOT NULL DEFAULT 0,
           `created_at` datetime NOT NULL DEFAULT current_timestamp(),
           PRIMARY KEY (`id`),
           KEY `ix_bucket` (`bucket`,`ident`,`created_at`),
           KEY `ix_ip` (`bucket`,`ip`,`created_at`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $done = true;
}

/**
 * Does the shared database carry this table?
 *
 * Asked about the LEGACY tables, not ours. `loyalty_programs` belongs to the
 * old web POS, and a panel that has only ever sold the desktop product has no
 * reason to have it. Joining a table that is not there is a 502 on the guest's
 * Kartlarim screen - which is the same blank screen this whole chain was built
 * to stop - so the join is built to match what is actually present.
 *
 * Answered from information_schema once per table per request.
 */
function pass_has_table(PDO $pass, string $name): bool {
    static $seen = [];
    if (array_key_exists($name, $seen)) return $seen[$name];
    try {
        $st = $pass->prepare("SELECT 1 FROM information_schema.tables
                               WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1");
        $st->execute([$name]);
        $seen[$name] = (bool)$st->fetchColumn();
    } catch (Throwable $e) { $seen[$name] = false; }
    return $seen[$name];
}
