import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../services/session.dart';
import '../theme.dart';
import 'print_jobs_screen.dart';

/// The bill: what the table owes, what may be done to it, and printing.
///
/// Payment is not here on purpose - money is taken at the till. Everything
/// else a waiter needs on the floor IS here, and every one of those is drawn
/// from the permission list the till sent at bootstrap. A waiter who may not
/// discount does not get a disabled Discount button that fails when pressed;
/// they get no button, and the sheet says why in one word.
class BillScreen extends StatefulWidget {
  final int orderId;
  final String tableName;
  const BillScreen({super.key, required this.orderId, required this.tableName});
  @override
  State<BillScreen> createState() => _BillScreenState();
}

class _BillScreenState extends State<BillScreen> {
  Map<String, dynamic>? order;
  bool loading = true;
  String? error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final r = await Api.instance.call('GET', '/api/mobile/orders/${widget.orderId}');
      if (mounted) setState(() { order = r['order'] as Map<String, dynamic>; loading = false; });
    } catch (e) {
      if (mounted) setState(() { error = e.toString(); loading = false; });
    }
  }

  Future<void> _print() async {
    try {
      await Api.instance.call('POST', '/api/mobile/orders/${widget.orderId}/print', {});
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Hesap fisi kasadaki yaziciya gonderildi'), backgroundColor: NokTheme.ok));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'), backgroundColor: const Color(0xFFB42318)));
    }
  }

  Future<void> _mail() async {
    final c = TextEditingController();
    final email = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Colors.white,
        title: const Text('Hesabi e-posta ile gonder'),
        content: TextField(controller: c, autofocus: true, keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(labelText: 'Misafirin e-postasi')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Vazgec')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('Gonder')),
        ],
      ),
    );
    if (email == null || email.isEmpty) return;
    try {
      await Api.instance.call('POST', '/api/mobile/orders/${widget.orderId}/mail', {'email': email});
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Hesap $email adresine gonderiliyor'), backgroundColor: NokTheme.ok));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'), backgroundColor: const Color(0xFFB42318)));
    }
  }

  /* ---------------------------------------------------------------- *
   *  The actions sheet - the handheld's İşlemler                       *
   * ---------------------------------------------------------------- */

  Future<void> _send() async {
    try {
      await Api.instance.sendToStations(widget.orderId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Mutfağa gönderildi'), backgroundColor: NokTheme.ok));
      _load();
    } catch (e) { _oops(e); }
  }

  Future<void> _reprintSlip() async {
    final stations = Session.instance.stations;
    int? pick;
    if (stations.length > 1) {
      pick = await showModalBottomSheet<int>(
        context: context,
        backgroundColor: Colors.white,
        builder: (ctx) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Padding(padding: EdgeInsets.all(16),
                child: Text('Hangi istasyon?', style: TextStyle(fontWeight: FontWeight.w700))),
            for (final st in stations)
              ListTile(title: Text(st.name), onTap: () => Navigator.pop(ctx, st.id)),
            ListTile(title: const Text('Hepsi'), onTap: () => Navigator.pop(ctx, 0)),
          ]),
        ),
      );
      if (pick == null) return;
    }
    try {
      await Api.instance.reprintStationSlip(widget.orderId,
          stationId: (pick == null || pick == 0) ? null : pick);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Mutfak fişi tekrar yazdırıldı'), backgroundColor: NokTheme.ok));
    } catch (e) { _oops(e); }
  }

  Future<void> _transfer() async {
    final plan = await Api.instance.call('GET', '/api/mobile/tables');
    final tables = ((plan['tables'] ?? []) as List)
        .map((t) => TableInfo.fromJson(t as Map<String, dynamic>))
        .where((t) => !t.busy)
        .toList();
    if (!mounted) return;
    if (tables.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Boş masa yok')));
      return;
    }
    final chosen = await showModalBottomSheet<int>(
      context: context,
      backgroundColor: Colors.white,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Padding(padding: EdgeInsets.all(16),
              child: Text('Hangi masaya?', style: TextStyle(fontWeight: FontWeight.w700))),
          Flexible(
            child: GridView.count(
              shrinkWrap: true,
              crossAxisCount: 4,
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
              mainAxisSpacing: 8, crossAxisSpacing: 8, childAspectRatio: 1.5,
              children: [
                for (final t in tables)
                  OutlinedButton(
                      onPressed: () => Navigator.pop(ctx, t.id), child: Text(t.name)),
              ],
            ),
          ),
        ]),
      ),
    );
    if (chosen == null) return;
    try {
      await Api.instance.transferTable(widget.orderId, chosen);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Masa taşındı'), backgroundColor: NokTheme.ok));
      Navigator.of(context).pop(true);
    } catch (e) { _oops(e); }
  }

  Future<void> _discount() async {
    final pct = await showModalBottomSheet<double>(
      context: context,
      backgroundColor: Colors.white,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Padding(padding: EdgeInsets.all(16),
              child: Text('İndirim', style: TextStyle(fontWeight: FontWeight.w700))),
          Wrap(spacing: 10, runSpacing: 10, children: [
            for (final p in [5.0, 10.0, 15.0, 20.0])
              SizedBox(width: 78, height: 48,
                  child: OutlinedButton(
                      onPressed: () => Navigator.pop(ctx, p),
                      child: Text('%${p.toStringAsFixed(0)}'))),
          ]),
          const SizedBox(height: 16),
        ]),
      ),
    );
    if (pct == null) return;
    try {
      await Api.instance.discount(widget.orderId, percent: pct, reason: 'Telefondan indirim');
      if (!mounted) return;
      _load();
    } catch (e) { _oops(e); }
  }

  Future<void> _cancelLine(Map<String, dynamic> it) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Colors.white,
        title: Text('${it['product_name']} iptal'),
        content: const Text('Bu satır adisyondan düşülecek ve mutfağa gittiyse '
            'mutfak ekranından da kaldırılacak.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Vazgeç')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('İptal et')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.instance.cancelLine(widget.orderId, it['id'] as int,
          reason: 'Telefondan iptal');
      if (!mounted) return;
      _load();
    } catch (e) { _oops(e); }
  }

  void _oops(Object e) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$e'), backgroundColor: const Color(0xFFB42318)));
  }

  /*
   * NAMING A BILL.
   *
   * A table with four bills on it is four people, and "A, B, C, D" is not how
   * a waiter holds them in his head - "Ahmet", "pencere kenari", "kirmizi
   * mont" is. The letters are what the till assigns so that something exists
   * to print; the name is what stops the wrong hesap reaching the wrong guest.
   *
   * The endpoint has been there all along. What was missing was anywhere to
   * type into, so a waiter carrying four open bills had four letters and his
   * own memory.
   */
  /// "S12 · Ahmet" once it has a name, "S12 · Hesap" before.
  String _title() {
    final l = '${order?['bill_label'] ?? ''}'.trim();
    return l.isEmpty ? '${widget.tableName} · Hesap' : '${widget.tableName} · $l';
  }

  Future<void> _rename() async {
    final o = order;
    if (o == null) return;
    final c = TextEditingController(text: '${o['bill_label'] ?? ''}');
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Adisyon adi'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
            controller: c,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            maxLength: 24,
            decoration: const InputDecoration(
              hintText: 'Ahmet, pencere kenari, kirmizi mont...',
              counterText: '',
            ),
            onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
          ),
          const SizedBox(height: 6),
          const Align(
            alignment: Alignment.centerLeft,
            child: Text('Bu isim fiste ve kasada gorunur. Bos birakirsan harf (A, B, C) kalir.',
                style: TextStyle(fontSize: 12, color: NokTheme.ink3)),
          ),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Vazgec')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, c.text.trim()),
              child: const Text('Kaydet')),
        ],
      ),
    );
    if (name == null) return;
    try {
      await Api.instance.setLabel(widget.orderId, name);
      if (!mounted) return;
      _load();
    } catch (e) { _oops(e); }
  }

  /// Every row here is a permission. What the waiter may not do is shown
  /// greyed with the reason, rather than hidden - a waiter who cannot find
  /// "masa taşı" assumes the handset lacks it and walks to the till anyway.
  void _actions() {
    final s = Session.instance;
    Widget row(IconData icon, String label, bool allowed, VoidCallback onTap) => ListTile(
          leading: Icon(icon, color: allowed ? NokTheme.orangeDark : const Color(0xFFC3C8CF)),
          title: Text(label,
              style: TextStyle(color: allowed ? NokTheme.ink : const Color(0xFFC3C8CF))),
          trailing: allowed
              ? null
              : const Text('yetki yok',
                  style: TextStyle(fontSize: 11.5, color: Color(0xFFC3C8CF))),
          onTap: allowed
              ? () { Navigator.pop(context); onTap(); }
              : null,
        );
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Padding(padding: EdgeInsets.fromLTRB(18, 16, 18, 6),
              child: Align(alignment: Alignment.centerLeft,
                  child: Text('İşlemler', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)))),
          row(Icons.send_outlined, 'Mutfağa gönder', s.canOrder, _send),
          row(Icons.print_outlined, 'Mutfak fişini tekrar yazdır', s.canOrder, _reprintSlip),
          row(Icons.swap_horiz, 'Masa taşı', s.canTransfer, _transfer),
          row(Icons.percent, 'İndirim', s.canDiscount, _discount),
          row(Icons.receipt_long_outlined, 'Yazdırma kuyruğu', true, () {
            Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const PrintJobsScreen()));
          }),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  /// One action: the icon above its word, so the word has the whole column and
  /// never has to break. 62 high - a thumb's worth - and a single line always.
  Widget _action(IconData icon, String label, VoidCallback onTap, {bool primary = false}) {
    final fg = primary ? Colors.white : NokTheme.ink;
    return Material(
      color: primary ? NokTheme.orange : Colors.white,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          height: 62,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: primary ? null : Border.all(color: const Color(0xFFD4D4D8)),
          ),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(icon, size: 21, color: primary ? Colors.white : NokTheme.orangeDark),
            const SizedBox(height: 4),
            Text(label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: fg)),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        /*
         * The title is the control. A waiter looking for "where do I name this
         * bill" looks at the name, so that is what has to be pressable - and it
         * carries a small pencil so that it looks pressable rather than being a
         * secret.
         */
        title: InkWell(
          onTap: order == null || !Session.instance.canOrder ? null : _rename,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Flexible(
                child: Text(
                  _title(),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (order != null && Session.instance.canOrder) ...[
                const SizedBox(width: 6),
                const Icon(Icons.edit_outlined, size: 16, color: NokTheme.ink3),
              ],
            ]),
          ),
        ),
        actions: [
          IconButton(
              tooltip: 'İşlemler',
              onPressed: order == null ? null : _actions,
              icon: const Icon(Icons.more_horiz)),
        ],
      ),
      body: loading
          ? const Center(child: CircularProgressIndicator(color: NokTheme.orange))
          : error != null
              ? Center(child: Padding(padding: const EdgeInsets.all(28),
                  child: Text(error!, textAlign: TextAlign.center, style: const TextStyle(color: NokTheme.ink2))))
              : _bill(),
      /*
       * THE ACTION BAR, AND WHY IT IS NOT THREE .icon BUTTONS IN A ROW.
       *
       * It was. On a 360dp handset each one got about a hundred pixels, the
       * icon took a third of that, and Material wrapped what was left - so a
       * waiter was offered "Gönd / er", "E- / posta" and "Yazd / ır". Three
       * buttons, none of them readable, on the screen he uses most.
       *
       * Icon over label fixes it outright: the full width of the column is
       * available to the word, nothing wraps, and the taller shape is a better
       * target for a thumb on the move. Yazdır stays filled because it is the
       * one that ends the job.
       */
      bottomNavigationBar: order == null ? null : SafeArea(
        child: Container(
          decoration: const BoxDecoration(
            color: Colors.white,
            border: Border(top: BorderSide(color: NokTheme.line)),
          ),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Row(children: [
            if (Session.instance.canOrder) ...[
              Expanded(child: _action(Icons.send_outlined, 'Mutfağa', _send)),
              const SizedBox(width: 8),
            ],
            Expanded(child: _action(Icons.mail_outline, 'E-posta', _mail)),
            const SizedBox(width: 8),
            Expanded(child: _action(Icons.print_outlined, 'Yazdır', _print, primary: true)),
          ]),
        ),
      ),
    );
  }

  Widget _bill() {
    final o = order!;
    final items = (o['items'] as List).cast<Map<String, dynamic>>();
    double d(dynamic v) => double.tryParse('$v') ?? 0;
    return ListView(padding: const EdgeInsets.all(14), children: [
      Card(
        color: Colors.white,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: const BorderSide(color: NokTheme.line)),
        child: Padding(padding: const EdgeInsets.all(16), child: Column(children: [
        Row(children: [
          // the label is how the table is spoken about once it holds more than
          // one bill - "masa 4 A" - so it goes first, where the eye lands
          if ('${o['bill_label'] ?? ''}'.trim().isNotEmpty) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                  color: const Color(0xFFFFF1E8), borderRadius: BorderRadius.circular(6)),
              child: Text('${o['bill_label']}',
                  style: const TextStyle(
                      color: NokTheme.orangeDark, fontWeight: FontWeight.w700, fontSize: 12.5)),
            ),
            const SizedBox(width: 8),
          ],
          Text('Adisyon #${o['adisyon_no']}', style: const TextStyle(fontWeight: FontWeight.w600)),
          const Spacer(),
          Text(o['status'] == 'open' ? 'acik' : 'kapali',
              style: TextStyle(color: o['status'] == 'open' ? NokTheme.orangeDark : NokTheme.ok)),
        ]),
        const Divider(height: 22, color: NokTheme.line),
        for (final it in items)
          InkWell(
            onLongPress: Session.instance.canCancelLine ? () => _cancelLine(it) : null,
            child:
          Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Row(children: [
            // a half sent from the phone or the till has to read back as a
            // half: toStringAsFixed(0) printed yarim porsiyon as "1x"
            SizedBox(width: 40, child: Text('${NokTheme.qty(d(it['qty']))}×',
                style: const TextStyle(fontWeight: FontWeight.w600))),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${it['product_name']}'),
              if (it['note'] != null && '${it['note']}'.isNotEmpty)
                Text('${it['note']}', style: const TextStyle(color: NokTheme.ink3, fontSize: 12)),
            ])),
            Text(NokTheme.tl(d(it['line_total'])), style: const TextStyle(fontWeight: FontWeight.w600)),
          ]))),
        const Divider(height: 22, color: NokTheme.line),
        _row('Ara toplam', d(o['total'])),
        if (d(o['discount_total']) > 0) _row('Indirim', -d(o['discount_total'])),
        _row('KDV', d(o['vat_total'])),
        if (d(o['paid']) > 0) _row('Odenen', d(o['paid'])),
        const SizedBox(height: 8),
        Row(children: [
          Text(d(o['paid']) > 0 ? 'Kalan' : 'Toplam',
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          const Spacer(),
          Text(NokTheme.tl(d(o['paid']) > 0 ? d(o['due']) : d(o['grand_total'])),
              style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
        ]),
      ]))),
      const SizedBox(height: 12),
      Text(
          Session.instance.canCancelLine
              ? 'Ödeme kasada alınır. Bir satırı iptal etmek için basılı tutun.'
              : 'Ödeme kasada alınır.',
          textAlign: TextAlign.center,
          style: const TextStyle(color: NokTheme.ink3, fontSize: 12.5)),
    ]);
  }

  Widget _row(String label, double v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          Text(label, style: const TextStyle(color: NokTheme.ink2)),
          const Spacer(),
          Text(NokTheme.tl(v), style: const TextStyle(color: NokTheme.ink2)),
        ]),
      );
}
