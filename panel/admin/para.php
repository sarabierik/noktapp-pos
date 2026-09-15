<?php
/**
 * The write side of Bayiler and Para: every POST the money and reseller
 * screens send.
 *
 * It sits beside chain.php and is dispatched the same way, from the one POST
 * block in index.php, for one reason: a redirect. Every action here ends in
 * Post/Redirect/Get so a refresh cannot issue a second invoice or record a
 * payment twice, and header() has to run before a byte of the page is on the
 * wire. The page files under admin/pages/ are included after layout_head(),
 * far too late to redirect from.
 *
 * Each handler returns nothing and exits; falling off the end means the POST
 * was not one of ours.
 */
require_once __DIR__ . '/../lib/para.php';

/**
 * Dispatch. $a is $_POST['action']; CSRF has already been checked by the
 * caller, exactly as it is for the chain actions.
 */
function para_actions(string $a): void {

    /* ---------------------------------------------------------------- */
    /* resellers                                                        */
    /* ---------------------------------------------------------------- */

    if ($a === 'bayi_save') {
        $id = (int) ($_POST['id'] ?? 0);
        $code = strtoupper(trim($_POST['code'] ?? '')) ?: ('B' . random_int(1000, 9999));
        $pct = max(0, min(100, (float) str_replace(',', '.', (string) ($_POST['commission_pct'] ?? 0))));
        $email = strtolower(trim($_POST['email'] ?? ''));
        try {
            if ($id) {
                q('UPDATE np_resellers SET code=?, name=?, contact=?, email=?, phone=?, city=?,
                     commission_pct=?, is_active=?, notes=? WHERE id=?',
                  [$code, trim($_POST['name'] ?? ''), $_POST['contact'] ?? null, $email,
                   $_POST['phone'] ?? null, $_POST['city'] ?? null, number_format($pct, 2, '.', ''),
                   isset($_POST['is_active']) ? 1 : 0, $_POST['notes'] ?? null, $id]);
                audit('bayi.update', $_POST['name'] ?? '', ['id' => $id, 'pct' => $pct]);
                $_SESSION['flash'] = 'Bayi kaydedildi.';
            } else {
                if (strlen((string) ($_POST['password'] ?? '')) < 6) {
                    $_SESSION['flash'] = 'Yeni bayi için en az 6 karakterlik bir şifre gerekli.';
                    header('Location: index.php?p=bayiler'); exit;
                }
                q('INSERT INTO np_resellers (code, name, contact, email, phone, city, commission_pct,
                     password_hash, is_active, notes) VALUES (?,?,?,?,?,?,?,?,1,?)',
                  [$code, trim($_POST['name'] ?? ''), $_POST['contact'] ?? null, $email,
                   $_POST['phone'] ?? null, $_POST['city'] ?? null, number_format($pct, 2, '.', ''),
                   password_hash($_POST['password'], PASSWORD_BCRYPT), $_POST['notes'] ?? null]);
                $id = lastId();
                audit('bayi.create', $_POST['name'] ?? '', ['id' => $id]);
                $_SESSION['flash'] = 'Bayi oluşturuldu. Bayi girişi: /bayi/';
            }
        } catch (Throwable $e) {
            /* code and e-mail are both UNIQUE, and the reseller signs in with
               the e-mail, so a duplicate has to be refused rather than
               silently merged into somebody else's account. */
            $_SESSION['flash'] = (stripos($e->getMessage(), 'duplicate') !== false)
                ? 'Bu bayi kodu ya da e-posta başka bir bayide kayıtlı.'
                : 'Bayi kaydedilemedi: ' . $e->getMessage();
            header('Location: index.php?p=bayiler'); exit;
        }
        header('Location: index.php?p=bayi&id=' . $id); exit;
    }

    if ($a === 'bayi_password') {
        $id = (int) ($_POST['id'] ?? 0);
        $pw = trim((string) ($_POST['password'] ?? '')) ?: strtoupper(bin2hex(random_bytes(4)));
        if (strlen($pw) < 6) {
            $_SESSION['flash'] = 'Şifre en az 6 karakter olmalı.';
        } elseif (bayi_get($id)) {
            q('UPDATE np_resellers SET password_hash=? WHERE id=?', [password_hash($pw, PASSWORD_BCRYPT), $id]);
            audit('bayi.password', 'bayi#' . $id);
            /* Shown once, exactly like the tenant password reset, so it is
               read out on the phone now rather than stored anywhere. */
            $_SESSION['flash'] = 'Yeni bayi şifresi: ' . $pw . ' — bir daha gösterilmeyecek.';
        }
        header('Location: index.php?p=bayi&id=' . $id); exit;
    }

    /* Who sold this customer. Lives on the customer page because that is where
       the question comes up, and it is the only place np_tenants.reseller_id
       is ever written. */
    if ($a === 'tenant_reseller') {
        $tid = (int) ($_POST['tenant_id'] ?? 0);
        $rid = (int) ($_POST['reseller_id'] ?? 0);
        if ($rid && !bayi_get($rid)) $rid = 0;
        q('UPDATE np_tenants SET reseller_id=? WHERE id=?', [$rid ?: null, $tid]);
        audit('tenant.reseller', 'tenant#' . $tid, ['reseller_id' => $rid], $tid);
        $_SESSION['flash'] = $rid ? 'Bayi atandı.' : 'Bayi bağlantısı kaldırıldı.';
        header('Location: index.php?p=tenant&id=' . $tid); exit;
    }

    /* ---------------------------------------------------------------- */
    /* invoices                                                         */
    /* ---------------------------------------------------------------- */

    if ($a === 'fatura_create') {
        $tid = (int) ($_POST['tenant_id'] ?? 0);
        $t = one('SELECT id FROM np_tenants WHERE id=?', [$tid]);
        if (!$t) { $_SESSION['flash'] = 'İşletme bulunamadı.'; header('Location: index.php?p=faturalar'); exit; }

        $rate = (float) str_replace(',', '.', (string) ($_POST['vat_rate'] ?? PARA_VAT_RATE));
        $amount = (float) str_replace(',', '.', (string) ($_POST['amount'] ?? 0));
        /* The form asks which figure was typed and says so in its label. There
           is no default guess: an invoice built from the wrong end of the KDV
           is out by a sixth, and nobody notices until the accountant does. */
        $basis = ($_POST['basis'] ?? 'net') === 'gross' ? 'gross' : 'net';

        $id = para_invoice_create([
            'tenant_id' => $tid,
            $basis => $amount,
            'vat_rate' => $rate,
            'issued_at' => ($_POST['issued_at'] ?? '') ?: date('Y-m-d'),
            'due_at' => ($_POST['due_at'] ?? '') ?: null,
            'period_start' => ($_POST['period_start'] ?? '') ?: null,
            'period_end' => ($_POST['period_end'] ?? '') ?: null,
            'status' => in_array($_POST['status'] ?? '', ['draft', 'sent'], true) ? $_POST['status'] : 'draft',
            'note' => ($_POST['note'] ?? '') ?: null,
        ]);
        if (!$id) {
            $_SESSION['flash'] = 'Bu işletmenin bu dönem için zaten bir faturası var — ikincisi kesilmedi.';
            header('Location: index.php?p=faturalar&tenant=' . $tid); exit;
        }
        audit('fatura.create', 'fatura#' . $id, ['basis' => $basis, 'amount' => $amount, 'vat' => $rate], $tid);
        $_SESSION['flash'] = 'Fatura kesildi.';
        header('Location: index.php?p=fatura&id=' . $id); exit;
    }

    if ($a === 'fatura_status') {
        $id = (int) ($_POST['id'] ?? 0);
        $to = $_POST['status'] ?? '';
        $inv = one('SELECT * FROM np_invoices WHERE id=?', [$id]);
        if ($inv && in_array($to, ['draft', 'sent', 'cancelled'], true)) {
            if ($to === 'cancelled' && para_paid_k($id) > 0) {
                /* A paid invoice cannot be cancelled away: the money arrived
                   and the row that says so would be orphaned. */
                $_SESSION['flash'] = 'Tahsilatı olan fatura iptal edilemez. Önce ödemeyi kaldırın.';
            } else {
                q('UPDATE np_invoices SET status=? WHERE id=?', [$to, $id]);
                if ($to !== 'cancelled') para_invoice_settle($id);
                audit('fatura.status', $inv['no'], ['from' => $inv['status'], 'to' => $to], (int) $inv['tenant_id']);
                $_SESSION['flash'] = 'Fatura durumu: ' . para_status_label($to) . '.';
            }
        }
        header('Location: index.php?p=fatura&id=' . $id); exit;
    }

    /* The one bulk action worth having. Idempotent in the database, not here:
       see uq_invoice_period and para_renewal_run(). */
    if ($a === 'fatura_renew') {
        $days = max(1, min(365, (int) ($_POST['days'] ?? 30)));
        $r = para_renewal_run($days);
        audit('fatura.renew', $days . ' gün', $r);
        $_SESSION['flash'] = $r['created'] . ' yenileme faturası kesildi'
            . ($r['skipped'] ? ' · ' . $r['skipped'] . ' işletmenin bu dönem faturası zaten vardı, tekrar kesilmedi' : '')
            . '.';
        header('Location: index.php?p=faturalar'); exit;
    }

    /* ---------------------------------------------------------------- */
    /* payments                                                         */
    /* ---------------------------------------------------------------- */

    if ($a === 'odeme_add') {
        $tid = (int) ($_POST['tenant_id'] ?? 0);
        $amount = (float) str_replace(',', '.', (string) ($_POST['amount'] ?? 0));
        $invId = (int) ($_POST['invoice_id'] ?? 0);
        if ($amount <= 0) {
            $_SESSION['flash'] = 'Tutar sıfırdan büyük olmalı.';
            header('Location: index.php?p=' . ($invId ? 'fatura&id=' . $invId : 'odemeler')); exit;
        }
        $id = para_payment_add([
            'tenant_id' => $tid, 'invoice_id' => $invId ?: null,
            'paid_at' => ($_POST['paid_at'] ?? '') ?: date('Y-m-d'), 'amount' => $amount,
            'method' => $_POST['method'] ?? 'havale',
            'reference' => ($_POST['reference'] ?? '') ?: null, 'note' => ($_POST['note'] ?? '') ?: null,
        ]);
        if (!$id) {
            $_SESSION['flash'] = 'Ödeme kaydedilemedi: fatura bu işletmeye ait değil.';
            header('Location: index.php?p=odemeler'); exit;
        }
        audit('odeme.add', 'odeme#' . $id, ['amount' => $amount, 'invoice' => $invId], $tid);
        $_SESSION['flash'] = 'Ödeme kaydedildi.';
        header('Location: index.php?p=' . ($invId ? 'fatura&id=' . $invId : 'tenant&id=' . $tid)); exit;
    }

    if ($a === 'odeme_delete') {
        $id = (int) ($_POST['id'] ?? 0);
        $p = one('SELECT * FROM np_payments WHERE id=?', [$id]);
        if ($p) {
            q('DELETE FROM np_payments WHERE id=?', [$id]);
            if ($p['invoice_id']) para_invoice_settle((int) $p['invoice_id']);
            audit('odeme.delete', 'odeme#' . $id, ['amount' => $p['amount']], (int) $p['tenant_id']);
            $_SESSION['flash'] = 'Ödeme silindi ve fatura durumu güncellendi.';
        }
        header('Location: index.php?p=' . (!empty($p['invoice_id']) ? 'fatura&id=' . (int) $p['invoice_id'] : 'odemeler')); exit;
    }
}
