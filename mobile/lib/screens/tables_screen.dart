import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../services/session.dart';
import '../services/queue.dart';
import '../theme.dart';
import 'bill_picker.dart';
import 'order_screen.dart';
import 'pair_screen.dart';

/// The waiter's home screen: the floor plan, and how many orders are still
/// waiting to reach the till.
class TablesScreen extends StatefulWidget {
  const TablesScreen({super.key});
  @override
  State<TablesScreen> createState() => _TablesScreenState();
}

class _TablesScreenState extends State<TablesScreen> {
  List<Zone> zones = [];
  List<TableInfo> tables = [];
  List<Category> menu = [];
  int? zoneId;
  bool loading = true;
  String? error;
  int queued = 0;
  bool viaRelay = false;

  /// True while a tapped table's bills are being read. The floor plan keeps
  /// refreshing behind it, so taps have to be swallowed until the answer is
  /// in - two OrderScreens for one table is not a screen anyone wants.
  bool opening = false;

  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 20), (_) => _load(silent: true));
  }

  @override
  void dispose() { _timer?.cancel(); super.dispose(); }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() { loading = true; error = null; });
    try {
      final flushed = await OfflineQueue.flush();
      if (flushed.sent > 0 && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${flushed.sent} bekleyen siparis kasaya iletildi'),
              backgroundColor: NokTheme.ok));
      }
      final res = await Api.instance.call('GET', '/api/mobile/bootstrap');
      /* what this handset may do travels with the floor plan, so every screen
         below can ask Session instead of re-fetching it */
      Session.instance.adopt(res);
      if (!mounted) return;
      setState(() {
        zones = (res['zones'] as List).map((z) => Zone.fromJson(z)).toList();
        tables = (res['tables'] as List).map((t) => TableInfo.fromJson(t)).toList();
        menu = (res['menu'] as List).map((c) => Category.fromJson(c)).toList();
        zoneId ??= zones.isNotEmpty ? zones.first.id : null;
        viaRelay = Api.instance.lastCallUsedRelay;
        loading = false;
      });
    } on ApiException catch (e) {
      if (e.unauthorised && mounted) {
        await Api.instance.forget();
        Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const PairScreen()));
        return;
      }
      if (mounted) setState(() { error = e.message; loading = false; });
    } catch (e) {
      if (mounted) setState(() { error = 'Kasaya ulasilamadi'; loading = false; });
    }
    queued = await OfflineQueue.count();
    if (mounted) setState(() {});
  }

  /* ---------------------------------------------------------------- */
  /* which adisyon                                                     */
  /* ---------------------------------------------------------------- */

  /// Tapping a table asks the same question the till asks, in the same order.
  ///
  /// The phone used to push the order screen and let it take the table's first
  /// open bill. A table with two parties has two adisyons; taking the first put
  /// every round on whichever came back first, and nobody found out until
  /// somebody asked for the bill. So: no bills, go in. One bill, go in - asking
  /// would be noise, and the order screen still offers "yeni adisyon". More
  /// than one, ask, and never answer it for him.
  Future<void> _openTable(TableInfo t) async {
    if (opening) return;

    /*
     * A joined table has ONE bill for the whole party, and the floor plan
     * already carries its id. Without this masa 5 opens a second adisyon and
     * the group pays for one dinner twice - the till has guarded exactly this
     * since table groups shipped.
     */
    final groupBill = t.groupOrderId;
    if (groupBill != null) {
      await _push(t, BillChoice.existing(groupBill));
      return;
    }

    if (!t.busy) {
      await _push(t, const BillChoice.tableBill());
      return;
    }

    setState(() => opening = true);
    TableBills? data;
    try {
      data = await fetchTableBills(t.id);
    } catch (_) {
      data = null;   // the till is out of reach; we could not look
    }
    if (!mounted) return;
    setState(() => opening = false);

    // copied into a final local so there is no question about what is and is
    // not null below - this reads the same to the compiler and to a person
    final found = data;
    BillChoice? choice;
    if (found == null) {
      // "I could not look" is not "there is nothing there" - ask the waiter
      choice = await pickBillOffline(context, t.name, t.openBills);
    } else if (found.bills.isEmpty) {
      // the plan was stale and the table has since been settled
      choice = const BillChoice.tableBill();
    } else if (found.bills.length == 1) {
      choice = BillChoice.existing(found.bills.first.id);
    } else {
      choice = await pickBill(context, t.name, found);
    }
    final picked = choice;
    if (picked == null) return;
    if (!mounted) return;
    await _push(t, picked);
  }

  Future<void> _push(TableInfo t, BillChoice c) async {
    await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => OrderScreen(
            table: t, menu: menu, orderId: c.orderId, forceNew: c.isNew)));
    if (mounted) _load(silent: true);
  }

  /* ---------------------------------------------------------------- */

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Masalar'),
        actions: [
          if (queued > 0)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Center(child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(color: const Color(0xFFFFF1E8), borderRadius: BorderRadius.circular(12)),
                child: Text('$queued bekliyor', style: const TextStyle(color: NokTheme.orangeDark, fontSize: 12.5)))),
            ),
          IconButton(onPressed: () => _load(), icon: const Icon(Icons.refresh)),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(52),
          child: Container(
            height: 52,
            color: Colors.white,
            child: ListView(scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                for (final z in zones)
                  Padding(padding: const EdgeInsets.only(right: 8, top: 8, bottom: 8),
                    child: ChoiceChip(
                      label: Text(z.name),
                      selected: zoneId == z.id,
                      onSelected: (_) => setState(() => zoneId = z.id),
                      selectedColor: NokTheme.ink,
                      labelStyle: TextStyle(color: zoneId == z.id ? Colors.white : NokTheme.ink2),
                      side: const BorderSide(color: NokTheme.line),
                      backgroundColor: Colors.white)),
              ]),
          ),
        ),
      ),
      body: Stack(children: [
        Positioned.fill(child: _plan()),
        if (opening)
          Positioned.fill(
            child: AbsorbPointer(
              child: Container(
                color: const Color(0xB3FFFFFF),
                child: const Center(child: CircularProgressIndicator(color: NokTheme.orange)),
              ),
            ),
          ),
      ]),
      bottomNavigationBar: viaRelay
          ? Container(
              color: const Color(0xFFFFF1E8),
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 16),
              child: const Text('Restoran agi disindasiniz - istekler internet uzerinden iletiliyor.',
                  style: TextStyle(color: NokTheme.orangeDark, fontSize: 12.5), textAlign: TextAlign.center))
          : null,
    );
  }

  Widget _plan() {
    if (loading) return const Center(child: CircularProgressIndicator(color: NokTheme.orange));
    if (error != null) return _errorBox();
    final list = zoneId == null ? tables : tables.where((t) => t.zoneId == zoneId).toList();
    return RefreshIndicator(
      onRefresh: () => _load(),
      color: NokTheme.orange,
      child: GridView.builder(
        padding: const EdgeInsets.all(14),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2, childAspectRatio: 1.55, crossAxisSpacing: 12, mainAxisSpacing: 12),
        itemCount: list.length,
        itemBuilder: (_, i) => _tableCard(list[i]),
      ),
    );
  }

  Widget _errorBox() => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.wifi_off, size: 40, color: NokTheme.ink3),
            const SizedBox(height: 14),
            Text(error!, textAlign: TextAlign.center, style: const TextStyle(color: NokTheme.ink2)),
            const SizedBox(height: 8),
            const Text('Aldiginiz siparisler telefonda saklanir ve baglanti gelince otomatik iletilir.',
                textAlign: TextAlign.center, style: TextStyle(color: NokTheme.ink3, fontSize: 13)),
            const SizedBox(height: 18),
            OutlinedButton(onPressed: () async { await Api.instance.locate(force: true); _load(); },
                child: const Text('Kasayi tekrar ara')),
          ]),
        ),
      );

  Widget _tableCard(TableInfo t) {
    // "3 adisyon" tells a waiter nothing about which one is his party's;
    // "3 adisyon - A, B, C" lets him decide before the sheet even opens
    final line = t.busy
        ? (t.labels.isEmpty ? '${t.openBills} adisyon' : '${t.openBills} adisyon - ${t.labels}')
        : 'bos';
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () => _openTable(t),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: t.busy ? const Color(0xFFFFF1E8) : Colors.white,
          border: Border.all(color: t.busy ? NokTheme.orange : NokTheme.line),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(width: 8, height: 8,
                decoration: BoxDecoration(
                    color: t.busy ? NokTheme.orange : const Color(0xFFC9C9CE), shape: BoxShape.circle)),
            const SizedBox(width: 8),
            Expanded(child: Text(t.name,
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
          ]),
          const SizedBox(height: 4),
          Text(line,
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: NokTheme.ink3, fontSize: 12.5)),
          const Spacer(),
          Text(t.busy ? NokTheme.tl(t.openTotal) : '',
              style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: NokTheme.orangeDark)),
        ]),
      ),
    );
  }
}
