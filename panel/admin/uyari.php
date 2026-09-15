<?php
/**
 * The write side of Uyarılar: every POST the alerts screen sends.
 *
 * Same arrangement as admin/chain.php and admin/para.php and for the same
 * reason - Post/Redirect/Get. Pressing "şimdi çalıştır" and then refreshing
 * the page must not run the rules a second time, and header() has to run
 * before layout_head() puts a byte on the wire, which is far earlier than the
 * page file under admin/pages/ is included.
 *
 * Each handler redirects and exits; falling off the end means the POST was not
 * one of ours.
 */
require_once __DIR__ . '/../lib/uyari.php';

function uyari_actions(string $a): void {

    if ($a === 'uyari_rule_save') {
        $id = (int) ($_POST['id'] ?? 0);
        $rule = uyari_rule($id);
        if (!$rule) { $_SESSION['flash'] = 'Kural bulunamadı.'; header('Location: index.php?p=uyarilar'); exit; }
        /* The threshold is days and is clamped rather than validated away: a
           0 would mean "warn about everything, for ever" and a 3650 would mean
           "never warn", and both are somebody's slip rather than an intention. */
        $th = max(1, min(365, (int) ($_POST['threshold'] ?? $rule['threshold'])));
        $target = trim((string) ($_POST['target'] ?? ''));
        if ($target !== '' && !filter_var($target, FILTER_VALIDATE_EMAIL)) {
            $_SESSION['flash'] = 'Geçersiz e-posta adresi — kural değiştirilmedi.';
            header('Location: index.php?p=uyarilar'); exit;
        }
        q('UPDATE np_alert_rules SET threshold=?, target=?, is_active=? WHERE id=?',
          [$th, $target !== '' ? $target : null, isset($_POST['is_active']) ? 1 : 0, $id]);
        audit('alert.rule', $rule['kind'], ['threshold' => $th, 'target' => $target,
                                            'active' => isset($_POST['is_active']) ? 1 : 0]);
        $_SESSION['flash'] = 'Kural kaydedildi.';
        header('Location: index.php?p=uyarilar'); exit;
    }

    if ($a === 'uyari_run') {
        /* The screen's own button forces past the throttle: the man pressing it
           is the reason the throttle exists (to keep a monitoring service from
           re-scanning every customer every minute), not the thing it protects
           against. De-duplication still applies, so pressing it twice sends
           nothing twice. */
        $rep = uyari_run(['force' => true]);
        $_SESSION['flash'] = empty($rep['ok'])
            ? ('Uyarılar çalıştırılamadı: ' . ($rep['error'] ?? 'bilinmeyen hata'))
            : ($rep['sent'] . ' uyarı gönderildi · ' . $rep['skipped'] . ' zaten gönderilmişti · '
               . $rep['failed'] . ' başarısız');
        header('Location: index.php?p=uyarilar'); exit;
    }

    if ($a === 'uyari_dry') {
        /* A rehearsal: work out exactly what would go out, write nothing, send
           nothing. The owner gets to see the first run before it reaches a
           customer-facing inbox. */
        $rep = uyari_run(['dry' => true]);
        $_SESSION['uyari_dry'] = $rep;
        header('Location: index.php?p=uyarilar'); exit;
    }

    if ($a === 'uyari_secret') {
        uyari_roll_secret();
        audit('alert.secret', 'yenilendi');
        $_SESSION['flash'] = 'Yeni anahtar üretildi. cPanel cron satırını güncelleyin — '
                           . 'eski anahtarla yapılan çağrılar artık reddedilir.';
        header('Location: index.php?p=uyarilar'); exit;
    }

}
