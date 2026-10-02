import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../theme.dart';

/*
 * Which adisyon does this round belong to?
 *
 * The phone used to answer that question by itself: it read the table's open
 * bills and took the first one. On a six-top with two couples that put one
 * party's raki on the other party's tab, every round, and nobody found out
 * until somebody asked for the bill. The till has asked out loud for weeks.
 * This is the same thinking on a phone: ask only when there is genuinely a
 * choice, and never guess when there is.
 */

/// The open bills on a table, plus a short "what is on it" line per bill.
class TableBills {
  final List<OpenBill> bills;
  /// order id -> "2 Adana, 1 Ayran +3". Missing for a bill whose detail did
  /// not arrive; the chooser simply shows one line less rather than failing.
  final Map<int, String> summaries;
  const TableBills(this.bills, this.summaries);
}

/// Read the table's open bills. Throws when the till cannot be reached - the
/// caller has to handle that itself, because "I could not look" and "there is
/// nothing there" are very different answers.
Future<TableBills> fetchTableBills(int tableId) async {
  final r = await Api.instance.call('GET', '/api/mobile/tables/$tableId/order');
  final raw = (r['orders'] as List);
  final bills = <OpenBill>[];
  for (final e in raw) {
    bills.add(OpenBill.fromJson(e as Map<String, dynamic>));
  }
  final summaries = <int, String>{};
  /*
   * The detail calls only happen when there is actually something to choose
   * between. A table with one bill walks straight through, and paying for
   * three extra round trips there would be felt on every single tap.
   */
  if (bills.length > 1) {
    final jobs = <Future<void>>[];
    for (final b in bills) {
      jobs.add(_fill(b, summaries));
    }
    await Future.wait(jobs);
  }
  return TableBills(bills, summaries);
}

/// The one-line "what is on this bill". Best effort on purpose: a waiter has
/// to be able to pick a bill even if one of these calls times out.
Future<void> _fill(OpenBill b, Map<int, String> into) async {
  try {
    final r = await Api.instance.call('GET', '/api/mobile/orders/${b.id}');
    final o = r['order'];
    if (o is! Map) return;
    final items = o['items'];
    if (items is! List) return;
    final parts = <String>[];
    var more = 0;
    for (final it in items) {
      if (it is! Map) continue;
      if (parts.length >= 3) {
        more++;
        continue;
      }
      final q = double.tryParse('${it['qty']}') ?? 0;
      parts.add('${NokTheme.qty(q)} ${it['product_name']}');
    }
    if (parts.isEmpty) return;
    into[b.id] = more > 0 ? '${parts.join(', ')} +$more' : parts.join(', ');
  } catch (_) {
    // one bill's detail not arriving must not stop the waiter choosing
  }
}

/// The chooser, shown only when the table really does hold more than one bill.
Future<BillChoice?> pickBill(BuildContext context, String tableName, TableBills data) {
  return showModalBottomSheet<BillChoice>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    builder: (ctx) => SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              Expanded(
                  child: Text(tableName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700))),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                    color: const Color(0xFFFFF1E8),
                    borderRadius: BorderRadius.circular(12)),
                child: Text('${data.bills.length} açık adisyon',
                    style: const TextStyle(color: NokTheme.orangeDark, fontSize: 12.5)),
              ),
            ]),
            const SizedBox(height: 6),
            const Text('Sipariş hangi adisyona yazılsın?',
                style: TextStyle(color: NokTheme.ink2, fontSize: 13.5)),
            const SizedBox(height: 14),
            for (final b in data.bills)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _billButton(ctx, b, data.summaries[b.id]),
              ),
            const SizedBox(height: 2),
            SizedBox(
              height: 60,
              child: FilledButton.icon(
                onPressed: () => Navigator.pop(ctx, const BillChoice.newBill()),
                icon: const Icon(Icons.add, size: 22),
                label: const Text('Yeni adisyon'),
              ),
            ),
            const SizedBox(height: 10),
            const Text(
                'Yeni adisyon aynı masaya açılır ve kendi etiketini alır (A, B, C...). '
                'Her adisyon ayrı yazdırılır, ayrı ödenir.',
                style: TextStyle(color: NokTheme.ink3, fontSize: 12.5, height: 1.45)),
            const SizedBox(height: 6),
          ],
        ),
      ),
    ),
  );
}

Widget _billButton(BuildContext ctx, OpenBill b, String? summary) {
  // flattened to a plain String here on purpose: a nullable local does not
  // stay promoted through a collection-if, and Text() takes no nulls
  final String sum = summary ?? '';
  final age = b.age;
  return InkWell(
    borderRadius: BorderRadius.circular(12),
    onTap: () => Navigator.pop(ctx, BillChoice.existing(b.id)),
    child: Container(
      // a waiter is walking, holding a tray, sometimes wearing gloves
      constraints: const BoxConstraints(minHeight: 74),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(color: NokTheme.line),
          borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        Expanded(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(b.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              if (sum.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text(sum,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: NokTheme.ink2, fontSize: 12.5)),
                ),
              if (age.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(age,
                      style: const TextStyle(color: NokTheme.ink3, fontSize: 11.5)),
                ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        Text(NokTheme.tl(b.total),
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
      ]),
    ),
  );
}

/// The same question with the till out of reach.
///
/// Offline we cannot list the bills, so we cannot offer them - and letting the
/// round replay with no order_id means the till picks the table's FIRST bill
/// hours later, which is the original bug wearing a hat. So the waiter answers
/// it here, knowing what he is answering, instead of the queue answering it
/// for him in the middle of the next shift.
Future<BillChoice?> pickBillOffline(BuildContext context, String tableName, int openBills) {
  final single = openBills <= 1;
  return showModalBottomSheet<BillChoice>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    builder: (ctx) => SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              const Icon(Icons.wifi_off, size: 20, color: NokTheme.ink3),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(tableName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700))),
            ]),
            const SizedBox(height: 8),
            Text(
              single
                  ? 'Kasaya ulaşılamıyor. Bu masada bir adisyon açık görünüyor. '
                      'Siparişi ona ekleyebilir ya da yeni bir adisyon açabilirsiniz.'
                  : 'Kasaya ulaşılamıyor, bu masadaki $openBills adisyon şimdi okunamıyor. '
                      'Hangisine yazılacağı sorulamadığı için sipariş yeni bir adisyona yazılır. '
                      'Mevcut bir adisyona eklemek için bağlantıyı bekleyin.',
              style: const TextStyle(color: NokTheme.ink2, fontSize: 13.5, height: 1.45),
            ),
            const SizedBox(height: 18),
            if (single)
              SizedBox(
                height: 60,
                child: FilledButton(
                  onPressed: () => Navigator.pop(ctx, const BillChoice.tableBill()),
                  child: const Text('Masadaki adisyona ekle'),
                ),
              ),
            if (single) const SizedBox(height: 10),
            SizedBox(
              height: 60,
              child: single
                  ? OutlinedButton.icon(
                      onPressed: () => Navigator.pop(ctx, const BillChoice.newBill()),
                      icon: const Icon(Icons.add, size: 22),
                      label: const Text('Yeni adisyon'),
                    )
                  : FilledButton.icon(
                      onPressed: () => Navigator.pop(ctx, const BillChoice.newBill()),
                      icon: const Icon(Icons.add, size: 22),
                      label: const Text('Yeni adisyon'),
                    ),
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.center,
              child: TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Vazgeç', style: TextStyle(color: NokTheme.ink2)),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
