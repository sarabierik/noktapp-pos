<?php
/**
 * The guest-facing QR menu. Phones scan the code on the table and land here;
 * the restaurant's PC is never involved, it only publishes the menu up to us.
 */
require_once __DIR__ . '/../lib/db.php';
$slug = preg_replace('/[^a-z0-9\-]/', '', strtolower($_GET['s'] ?? ''));
$table = preg_replace('/[^A-Za-z0-9]/', '', $_GET['t'] ?? '');
$row = $slug ? one('SELECT * FROM np_qr_menus WHERE slug=?', [$slug]) : null;
if (!$row) { http_response_code(404); exit('Menü bulunamadı'); }
$d = json_decode($row['payload'], true);
$s = $d['settings'] ?? [];
$menu = $d['menu'] ?? [];
$name = $s['business_name'] ?: $slug;
function h($v){ return htmlspecialchars((string)$v, ENT_QUOTES, 'UTF-8'); }
?><!doctype html><html lang="tr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title><?= h($name) ?> · Menü</title>
<style>
:root{--orange:#FF7A1A;--ink:#18181B;--line:#EDEDEF}
*{box-sizing:border-box;margin:0}
body{background:#fff;color:var(--ink);font:16px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;padding-bottom:40px}
header{background:linear-gradient(150deg,#1B1B1F,#3A2A21);color:#fff;padding:34px 20px 26px}
header h1{font-size:26px;letter-spacing:-.4px}
header p{color:#C2C2CA;margin-top:6px;font-size:14px}
nav{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);display:flex;gap:8px;overflow-x:auto;padding:12px 16px;z-index:2}
nav a{white-space:nowrap;padding:7px 14px;border:1px solid var(--line);border-radius:16px;color:var(--ink);text-decoration:none;font-size:14px}
section{padding:22px 20px 6px}
section h2{font-size:18px;margin-bottom:12px}
.item{display:flex;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid var(--line)}
.item b{font-weight:600;font-size:15px}
.item p{color:#77777F;font-size:13px;margin-top:3px}
.price{font-weight:700;color:var(--orange);white-space:nowrap}
footer{padding:26px 20px;color:#9A9AA2;font-size:13px;text-align:center}
</style></head><body>
<header>
  <h1><?= h($name) ?></h1>
  <?php if (!empty($s['about'])): ?><p><?= h($s['about']) ?></p><?php endif; ?>
  <?php if ($table): ?><p>Masa kodunuz: <?= h(substr($table, 0, 6)) ?></p><?php endif; ?>
</header>
<nav><?php foreach ($menu as $c): ?><a href="#c<?= (int)$c['id'] ?>"><?= h($c['name']) ?></a><?php endforeach; ?></nav>
<?php foreach ($menu as $c): ?>
  <section id="c<?= (int)$c['id'] ?>"><h2><?= h($c['name']) ?></h2>
    <?php foreach (($c['products'] ?? []) as $p): ?>
      <div class="item"><div><b><?= h($p['name']) ?></b>
        <?php if (!empty($p['description'])): ?><p><?= h($p['description']) ?></p><?php endif; ?></div>
        <div class="price"><?= number_format((float)$p['price'], 2, ',', '.') ?> ₺</div></div>
    <?php endforeach; ?>
  </section>
<?php endforeach; ?>
<footer>
  <?php if (!empty($s['phone'])): ?><div><?= h($s['phone']) ?></div><?php endif; ?>
  <div style="margin-top:8px">NOKTApp POS</div>
</footer></body></html>
