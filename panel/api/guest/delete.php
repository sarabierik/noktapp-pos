<?php
/**
 * "Hesabimi sil" — and an honest account of what that does and does not reach.
 *
 * Both app stores require this to exist and to be reachable from inside the
 * app, so it is not optional. It asks for the password again, because a phone
 * left unlocked on a table should not be able to delete its owner's account.
 *
 * WHAT IS ERASED HERE
 *   Every personal field on the guest row: name, phone, e-mail, date of birth,
 *   password, card code. The row itself stays, deactivated and anonymous,
 *   because the loyalty cards point at it and a restaurant's stamp ledger is
 *   its own accounting record — the open liability on its books is money it
 *   owes. Anonymised, those rows are numbers about a card, not facts about a
 *   person.
 *   Every session, on every device. Every unspent one-time code. The whole
 *   mirrored movement history.
 *
 * WHAT THIS CANNOT REACH, AND THE GUEST IS TOLD SO
 *   The restaurants' own computers. A till caches a guest it has served so it
 *   can recognise them with the internet unplugged — that is the feature that
 *   makes the counter work — and those caches are on machines we do not
 *   control and cannot reach from here. They fall out of use because nothing
 *   resolves to them any more, but the name sits in a local database until
 *   that restaurant is asked directly.
 *   Saying otherwise in a privacy screen would be a lie, and it is the kind
 *   of lie a regulator reads out loud. Pushing a deletion instruction down to
 *   the tills is a real piece of work and it is not built yet.
 */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
guest_require_post();
$me   = guest_auth();
$pass = guest_pass();
$in   = json_in();

$confirm = (string)($in['password'] ?? '');
if (empty($me['password_hash']) || !password_verify($confirm, $me['password_hash'])) {
    guest_throttle($pass, 'delete', (string)(int)$me['id']);
    guest_attempt($pass, 'delete', (string)(int)$me['id'], false);
    fail('Hesabi silmek icin sifrenizi dogru girin', 403);
}

$id = (int)$me['id'];
try {
    $pass->beginTransaction();
    $pass->prepare(
        "UPDATE customers
            SET first_name='Silinmis kullanici', last_name=NULL, phone=NULL, email=NULL,
                birth_date=NULL, password_hash=NULL, qr_uid=NULL,
                is_verified=0, is_active=0, updated_at=NOW()
          WHERE id=?")->execute([$id]);
    $pass->prepare("DELETE FROM np_guest_sessions WHERE customer_id=?")->execute([$id]);
    $pass->prepare("DELETE FROM loyalty_qr_tokens WHERE customer_id=?")->execute([$id]);
    try { $pass->prepare("DELETE FROM np_guest_events WHERE customer_id=?")->execute([$id]); }
    catch (Throwable $e) { /* no till has mirrored events on this panel yet */ }
    $pass->commit();
} catch (Throwable $e) {
    if ($pass->inTransaction()) $pass->rollBack();
    error_log('guest delete: ' . $e->getMessage());
    fail('Hesap silinemedi', 502);
}

audit('guest.delete', 'customer ' . $id, ['customer' => $id]);
out(['ok' => true,
     'erased' => ['profil', 'sifre', 'kart kodu', 'oturumlar', 'karekodlar', 'hareket gecmisi'],
     'kept'   => 'Pul bakiyeleri restoranin kendi muhasebe kaydi oldugu icin isimsiz olarak kalir.',
     'note'   => 'Sizi daha once agirlamis restoranlarin kendi bilgisayarlarinda '
               . 'tutulan yerel kayitlari buradan silemiyoruz. Onlari dogrudan '
               . 'restorandan talep edebilirsiniz.']);
