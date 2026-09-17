import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../services/queue.dart';
import '../theme.dart';
import 'bill_picker.dart';
import 'bill_screen.dart';

/// Taking the order.
///
/// The waiter builds a draft on the phone and sends it in one go. That is
/// deliberate: one request per round means a weak signal costs one retry, not
/// eight, and the kitchen gets one slip instead of a line at a time.
///
/// The whole screen hangs off ONE question: which adisyon is this round for.
/// It used to answer that itself by taking the table's first open bill, which
/// is only ever right when the table has exactly one. Now the answer arrives
/// from the floor plan, is visible in the strip at the top, travels with the
/// round to the till, and travels with it into the offline queue as well.
class OrderScreen extends StatefulWidget {
  final TableInfo table;
  final List<Category> menu;

  /// The adisyon the waiter chose. null means "whatever bill this table has",
  /// which is only ever safe on an empty table or a table with exactly one -
  /// the floor plan is what makes sure of that before it pushes this screen.
  final int? orderId;

  /// Open ANOTHER adisyon on a table that already has one. This is the case
  /// that was impossible from the phone: two couples on a six-top.
  final bool forceNew;

  const OrderScreen({
    super.key,
    required this.table,
    required this.menu,
    this.orderId,
    this.forceNew = false,
  });

  @override
  State<OrderScreen> createState() => _OrderScreenState();
}

class _OrderScreenState extends State<OrderScreen> {
  final List<DraftLine> draft = [];
  /// null = the category CARDS are showing; an index = that category is open.
  /*
   * A CATEGORY IS ALWAYS OPEN NOW.
   *
   * It used to start null, which meant the first thing a waiter saw was a
   * grid of category cards - a whole screen spent choosing a heading before
   * a single product was visible, every single time he opened a table. The
   * rail down the left does that job without costing a screen: the categories
   * are permanently on view AND the products are too.
   */
  int catIndex = 0;

  /// Is the basket open? Collapsed by default - see _draftPanel.
  bool sepetAcik = false;
  String search = '';
  bool sending = false;

  /// The bill this round is being written on. Kept in step with [forceNew]:
  /// an id means a named bill, forceNew means a bill that does not exist yet,
  /// and neither means "the one this table has".
  int? orderId;
  bool forceNew = false;

  /// Every open bill on this table, for the strip and for the chooser.
  TableBills? loaded;

  /// Bumped after a send, so the Adisyon and İşlemler tabs re-fetch instead of
  /// showing the bill as it was before the round went in.
  int _billSurum = 0;

  /// How many lines the till already has on this bill - the number on the
  /// Adisyon tab. Filled from the bill list, which the screen reloads anyway.
  int gonderilenAdet = 0;

  List<OpenBill> get bills => loaded == null ? const <OpenBill>[] : loaded!.bills;

  @override
  void initState() {
    super.initState();
    orderId = widget.orderId;
    forceNew = widget.forceNew;
    _loadBills();
  }

  Future<void> _loadBills() async {
    try {
      final data = await fetchTableBills(widget.table.id);
      if (!mounted) return;
      setState(() {
        loaded = data;
        /*
         * Adopt a bill ONLY when there is exactly one and nothing was chosen.
         * The floor plan already asks whenever there is a choice to make; this
         * covers the table that turned busy between the tap and this call.
         * Taking bills.first when there are several is the bug this screen was
         * rewritten to kill - it must not creep back in here.
         */
        if (orderId == null && !forceNew && data.bills.length == 1) {
          orderId = data.bills.first.id;
        }
      });
    } catch (_) {
      // offline: the waiter has already answered the question in the sheet,
      // and whatever he answered is what the queued round will carry
    }
  }

  double get draftTotal => draft.fold(0.0, (s, l) => s + l.total);

  /// Tapping a product adds a WHOLE portion. The half is something a guest
  /// asks for, so it is asked for on the line, not here.
  void _add(Product p) {
    // a line WITH a note never merges with one without: "sogansiz" is not a
    // quantity, and the kitchen slip has to be able to say which one it is
    final same = draft.where((l) => l.product.id == p.id && l.note == null);
    setState(() {
      if (same.isNotEmpty) {
        same.first.qty += 1;
      } else {
        draft.add(DraftLine(p));
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* which bill                                                        */
  /* ---------------------------------------------------------------- */

  Future<void> _switchTo(int id) async {
    if (!forceNew && orderId == id) return;
    final go = await _confirmSwitch();
    if (!go || !mounted) return;
    setState(() {
      orderId = id;
      forceNew = false;
    });
  }

  Future<void> _switchToNew() async {
    if (forceNew) return;
    final go = await _confirmSwitch();
    if (!go || !mounted) return;
    setState(() {
      orderId = null;
      forceNew = true;
    });
  }

  /// Changing bills with a half typed round in hand moves that round onto the
  /// other guests' tab - the exact mistake this screen exists to prevent - so
  /// it gets asked out loud instead of assumed.
  Future<bool> _confirmSwitch() async {
    if (draft.isEmpty) return true;
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Colors.white,
        title: const Text('Adisyon degistirilsin mi?'),
        content: const Text('Sepetteki urunler secilen adisyona yazilacak.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Vazgec', style: TextStyle(color: NokTheme.ink2))),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true), child: const Text('Degistir')),
        ],
      ),
    );
    return yes == true;
  }

  /* ---------------------------------------------------------------- */
  /* sending                                                           */
  /* ---------------------------------------------------------------- */

  Future<void> _send() async {
    if (draft.isEmpty || sending) return;

    /*
     * Last gate before anything leaves the phone: never send a round to a
     * table that holds several bills without naming one. Without order_id the
     * till writes it on the table's FIRST open bill, and that is how one
     * party's round landed on the other party's tab for weeks.
     */
    final data = loaded;
    if (orderId == null && !forceNew && data != null && data.bills.length > 1) {
      final c = await pickBill(context, widget.table.name, data);
      if (c == null || !mounted) return;
      setState(() {
        orderId = c.orderId;
        forceNew = c.isNew;
      });
    }

    setState(() => sending = true);
    final items = draft
        .map((l) => {'product_id': l.product.id, 'qty': l.qty, 'note': l.note})
        .toList();

    // one body, built once, so the live call and the queued copy cannot
    // disagree about which bill this round belongs to
    final body = <String, dynamic>{
      'table_id': widget.table.id,
      'items': items,
      'send': true,
    };
    if (orderId != null) {
      body['order_id'] = orderId;
    } else if (forceNew) {
      body['force_new'] = true;
    }

    try {
      final res = await Api.instance.call('POST', '/api/mobile/orders/take', body);
      if (!mounted) return;
      final newId = int.tryParse('${res['order_id']}') ?? 0;
      setState(() {
        draft.clear();
        sending = false;
        // the bill the till just opened IS this screen's bill from now on -
        // otherwise a second round would open a third adisyon on the table
        if (newId > 0) {
          orderId = newId;
          forceNew = false;
        }
      });
      _loadBills();
      /*
       * It used to PUSH the bill screen here - a whole new page over the top
       * of the menu, every single time a round went to the kitchen, which the
       * waiter then had to back out of before he could take the next one.
       * The bill is a tab now, so sending simply refreshes it and leaves him
       * where he is standing.
       */
      setState(() { _billSurum++; sepetAcik = false; });
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Siparis mutfaga gonderildi'), backgroundColor: NokTheme.ok));
    } catch (e) {
      // no connection: keep it on the phone and replay it later, carrying the
      // chosen bill with it. A queued round that "finds a bill" at replay time
      // is the same bug, hours later, when nobody is watching.
      final op = <String, dynamic>{
        'type': 'take_order',
        'table_id': widget.table.id,
        'items': items,
        'send': true,
      };
      if (orderId != null) {
        op['order_id'] = orderId;
      } else if (forceNew) {
        op['force_new'] = true;
      }
      await OfflineQueue.add(op);
      if (!mounted) return;
      setState(() {
        draft.clear();
        sending = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text(
              'Baglanti yok - siparis telefonda saklandi, baglanti gelince gonderilecek'),
          backgroundColor: NokTheme.orangeDark,
          duration: Duration(seconds: 4)));
      Navigator.of(context).pop();
    }
  }

  /* ---------------------------------------------------------------- */
  /* the note                                                          */
  /* ---------------------------------------------------------------- */

  /// One sheet, two doors into it: long-pressing the product (where the
  /// thought actually happens - the guest says it while pointing at the menu)
  /// and the labelled "Not" button on the draft line. The owner looked for the
  /// old pencil icon, did not find it, and concluded the feature was missing;
  /// a control that has to be discovered does not exist.
  Future<String?> _noteSheet(String productName, String initial, String action) {
    final c = TextEditingController(text: initial);
    const chips = [
      'az pismis',
      'orta',
      'iyi pismis',
      'sogansiz',
      'acisiz',
      'az buzlu',
      'ayri gelsin'
    ];
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(productName,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                const Text('Mutfak notu',
                    style: TextStyle(color: NokTheme.ink3, fontSize: 12.5)),
                const SizedBox(height: 12),
                TextField(
                    controller: c,
                    autofocus: true,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: const InputDecoration(hintText: 'ornek: sogansiz, az pismis')),
                const SizedBox(height: 12),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final t in chips)
                    ActionChip(
                      label: Text(t),
                      // chips ADD to the note instead of replacing it: a guest
                      // who wants it az pismis usually also wants it sogansiz
                      onPressed: () {
                        final cur = c.text.trim();
                        c.text = cur.isEmpty ? t : '$cur, $t';
                        c.selection =
                            TextSelection.fromPosition(TextPosition(offset: c.text.length));
                      },
                      backgroundColor: Colors.white,
                      side: const BorderSide(color: NokTheme.line),
                    ),
                ]),
                const SizedBox(height: 18),
                Row(children: [
                  Expanded(
                      child: OutlinedButton(
                          onPressed: () => Navigator.pop(ctx),
                          child: const Text('Vazgec'))),
                  const SizedBox(width: 10),
                  Expanded(
                      child: FilledButton(
                          onPressed: () => Navigator.pop(ctx, c.text),
                          child: Text(action))),
                ]),
                const SizedBox(height: 8),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _editNote(DraftLine line) async {
    final res = await _noteSheet(line.product.name, line.note ?? '', 'Kaydet');
    if (res == null || !mounted) return;
    final clean = res.trim();
    setState(() => line.note = clean.isEmpty ? null : clean);
  }

  Future<void> _addWithNote(Product p) async {
    final res = await _noteSheet(p.name, '', 'Ekle');
    if (res == null || !mounted) return;
    final clean = res.trim();
    // always its own line, never merged into an existing one - see _add
    setState(() => draft.add(DraftLine(p, note: clean.isEmpty ? null : clean)));
  }

  /* ---------------------------------------------------------------- */
  /* build                                                             */
  /* ---------------------------------------------------------------- */

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      /* Ürün Ekle first: nine times out of ten a table is opened to put
         something on it, and the tab a waiter wants should already be the
         one in front of him. */
      initialIndex: 1,
      child: Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Text(_baslik(), overflow: TextOverflow.ellipsis),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(46),
          child: Container(
            color: Colors.white,
            child: TabBar(
              labelColor: NokTheme.orangeDark,
              unselectedLabelColor: NokTheme.ink3,
              indicatorColor: NokTheme.orange,
              indicatorWeight: 3,
              indicatorSize: TabBarIndicatorSize.tab,
              labelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
              unselectedLabelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
              tabs: [
                Tab(
                  height: 46,
                  child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    const Text('Adisyon'),
                    /* The count is the thing Wolvox gets right and we did not:
                       a waiter can see there is something on this table
                       without opening the tab. */
                    if (gonderilenAdet > 0) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                        decoration: BoxDecoration(
                            color: NokTheme.orange, borderRadius: BorderRadius.circular(9)),
                        child: Text('$gonderilenAdet',
                            style: const TextStyle(
                                color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
                      ),
                    ],
                  ]),
                ),
                const Tab(height: 46, text: 'Ürün Ekle'),
                const Tab(height: 46, text: 'İşlemler'),
              ],
            ),
          ),
        ),
      ),
      body: Column(children: [
        /* The bills on this table stay above the tabs, not inside one: which
           adisyon you are writing on is true of all three tabs, and a waiter
           who switches bill on "Ürün Ekle" must not find the "Adisyon" tab
           still showing the other one. */
        _billStrip(),
        Expanded(
          child: TabBarView(children: [
            _adisyonTab(),
            _urunEkleTab(),
            _islemlerTab(),
          ]),
        ),
      ]),
     ),
    );
  }

  /* =================================================================== *
   * THE THREE TABS                                                       *
   * =================================================================== *
   *
   * Adding products lived on one screen and reading the bill on another,
   * with a back button between them - and that is the trip a waiter makes
   * twenty times a service: put a round on, look at what they have had, put
   * another round on. Three tabs over one table, and the trip is a thumb
   * moving two centimetres.
   *
   * The order is the order of the work: what is on the table, what to add to
   * it, what to do with it.
   */

  /// Tab 1 - the bill as the till has it. The embedded BillScreen keeps its
  /// own loading and refresh, so nothing about how a bill is fetched changed
  /// in order to put it here.
  /// "S4 · #80" - the table, and which adisyon is being written on.
  String _baslik() {
    final b = bills.where((x) => x.id == orderId);
    if (b.isEmpty) return widget.table.name;
    return '${widget.table.name} · ${b.first.shortName}';
  }

  Widget _adisyonTab() {
    final id = orderId;
    if (id == null) return _bosAdisyon('Bu masada henüz adisyon yok.',
        'Ürün Ekle sekmesinden ürün seçip mutfağa gönderin.');
    return BillScreen(
        key: ValueKey('bill-$id-$_billSurum'),
        orderId: id, tableName: widget.table.name, embedded: true, embeddedTab: 0,
        onLineCount: (n) {
          if (mounted && n != gonderilenAdet) setState(() => gonderilenAdet = n);
        });
  }

  /// Tab 3 - masa taşı, indirim, adisyon adı, notlar, yazdırma.
  Widget _islemlerTab() {
    final id = orderId;
    if (id == null) return _bosAdisyon('İşlemler için önce adisyon gerekir.',
        'Ürün Ekle sekmesinden ilk ürünü gönderdiğinizde açılır.');
    return BillScreen(
        key: ValueKey('act-$id-$_billSurum'),
        orderId: id, tableName: widget.table.name, embedded: true, embeddedTab: 1);
  }

  Widget _bosAdisyon(String baslik, String alt) => Center(
        child: Padding(
          padding: const EdgeInsets.all(30),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.receipt_long_outlined, size: 42, color: Color(0xFFC9C9CE)),
            const SizedBox(height: 14),
            Text(baslik,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text(alt,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13, color: NokTheme.ink3, height: 1.4)),
          ]),
        ),
      );

  /// Tab 2 - the menu, and the basket bar along the bottom.
  Widget _urunEkleTab() {
    /* Computed here rather than in build(): only this tab needs them, and the
       other two rebuild every time a category is tapped. */
    final cat = widget.menu.isEmpty
        ? null
        : widget.menu[catIndex.clamp(0, widget.menu.length - 1)];
    final products = search.isEmpty
        ? (cat?.products ?? <Product>[])
        : widget.menu
            .expand((c) => c.products)
            .where((p) => p.name.toLowerCase().contains(search.toLowerCase()))
            .toList();
    return Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
          child: TextField(
            onChanged: (v) => setState(() => search = v),
            decoration: const InputDecoration(
                hintText: 'Urun ara',
                prefixIcon: Icon(Icons.search, color: NokTheme.ink3),
                contentPadding: EdgeInsets.symmetric(vertical: 4, horizontal: 12)),
          ),
        ),
        /*
         * KATEGORİ RAYI SOLDA, ÜRÜNLER SAĞDA.
         *
         * Three things were wrong with what was here, and they were the same
         * thing three times: the screen kept spending itself on navigation
         * instead of on the menu.
         *
         * A strip of chips ran off the side once a menu had eight categories,
         * so it was replaced by a grid of category CARDS - which cost a whole
         * screen, every time a table was opened, before one product could be
         * seen. Then a back button to leave the category, and a header saying
         * which one you were in, because by then you could not see the others.
         * Three controls to answer a question - "which part of the menu" -
         * that a list down the left answers permanently, for free.
         *
         * So: the rail always shows every category, the products are always
         * on screen beside it, and switching section is one tap that never
         * leaves the products. A row per product rather than a tile two
         * across fits nine on a handset instead of four, which is what a
         * waiter taking a round of drinks actually needs.
         */
        Expanded(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (search.isEmpty)
              Container(
                width: 104,
                decoration: const BoxDecoration(
                    color: Colors.white,
                    border: Border(right: BorderSide(color: NokTheme.line))),
                child: ListView.builder(
                  padding: EdgeInsets.zero,
                  itemCount: widget.menu.length,
                  itemBuilder: (_, i) {
                    final c = widget.menu[i];
                    final on = i == catIndex;
                    return InkWell(
                      onTap: () => setState(() => catIndex = i),
                      child: Container(
                        padding: const EdgeInsets.fromLTRB(9, 11, 7, 11),
                        decoration: BoxDecoration(
                          color: on ? NokTheme.orange : Colors.white,
                          border: const Border(
                              bottom: BorderSide(color: Color(0xFFF0F0F2))),
                        ),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Row(children: [
                            Container(
                                width: 3, height: 12,
                                decoration: BoxDecoration(
                                    color: on ? Colors.white : NokTheme.categoryColour(i),
                                    borderRadius: BorderRadius.circular(2))),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(c.name,
                                  maxLines: 2, overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                      fontSize: 11.5,
                                      height: 1.25,
                                      fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                                      color: on ? Colors.white : NokTheme.ink)),
                            ),
                          ]),
                          const SizedBox(height: 2),
                          Padding(
                            padding: const EdgeInsets.only(left: 9),
                            child: Text('${c.products.length}',
                                style: TextStyle(
                                    fontSize: 9.5,
                                    color: on ? Colors.white70 : NokTheme.ink3)),
                          ),
                        ]),
                      ),
                    );
                  },
                ),
              ),
            Expanded(
              child: products.isEmpty
                  ? Center(
                      child: Text(search.isEmpty ? 'Bu kategoride ürün yok' : 'Ürün bulunamadı',
                          style: const TextStyle(color: NokTheme.ink3)))
                  : ListView.separated(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      itemCount: products.length,
                      separatorBuilder: (_, __) =>
                          const Divider(height: 1, thickness: 1, color: Color(0xFFF0F0F2)),
                      itemBuilder: (_, i) {
                        final p = products[i];
                        final out = p.trackStock && p.stock <= 0;
                        return Opacity(
                          opacity: out ? .45 : 1,
                          child: InkWell(
                            onTap: out ? null : () => _add(p),
                            /* note on a long press, as before - the hint above
                               the list says so until the first line is added */
                            onLongPress: out ? null : () => _addWithNote(p),
                            child: Container(
                              color: Colors.white,
                              padding: const EdgeInsets.fromLTRB(12, 11, 10, 11),
                              child: Row(children: [
                                Expanded(
                                  child: Text(p.name,
                                      maxLines: 2, overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                          fontSize: 14, fontWeight: FontWeight.w500, height: 1.3)),
                                ),
                                const SizedBox(width: 10),
                                Text(NokTheme.tl(p.price),
                                    style: const TextStyle(
                                        fontSize: 14.5,
                                        fontWeight: FontWeight.w700,
                                        color: NokTheme.orangeDark)),
                                /*
                                 * THE NOTE BUTTON, BECAUSE A LONG PRESS IS
                                 * NOT A FEATURE ANYBODY FINDS.
                                 *
                                 * Adding a product with a note has worked for
                                 * months - hold the product down. Holding
                                 * things down is not something waiters try on
                                 * a screen they are using at speed, and the
                                 * one line of hint text above the list is read
                                 * once and then never again. "Acisiz" was
                                 * being shouted across the pass instead.
                                 *
                                 * The long press still works. This is just the
                                 * same thing, visible.
                                 */
                                const SizedBox(width: 4),
                                InkWell(
                                  onTap: out ? null : () => _addWithNote(p),
                                  borderRadius: BorderRadius.circular(8),
                                  child: Padding(
                                    padding: const EdgeInsets.all(5),
                                    child: Icon(Icons.edit_note,
                                        size: 21,
                                        color: out ? NokTheme.ink3 : NokTheme.ink3),
                                  ),
                                ),
                                const SizedBox(width: 2),
                                Icon(Icons.add_circle_outline,
                                    size: 20,
                                    color: out ? NokTheme.ink3 : NokTheme.orange),
                              ]),
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ]),
        ),
        if (draft.isNotEmpty) _draftPanel(),
      ]);
  }

  /// The other bills on this table, as tabs - and the way to open one more.
  ///
  /// The strip is the only place the phone ever states which adisyon it is
  /// writing on, so it is never hidden while there is a bill on the table.
  /// "+ Yeni adisyon" lives here because a busy table must ALWAYS be able to
  /// open another one, including the single-bill table the floor plan walked
  /// straight into without asking.
  Widget _billStrip() {
    final list = bills;
    if (list.isEmpty && !forceNew) return const SizedBox.shrink();
    return Container(
      height: 58,
      decoration: const BoxDecoration(
          color: Colors.white, border: Border(bottom: BorderSide(color: NokTheme.line))),
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        children: [
          for (final b in list)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: _billChip(
                label: b.shortName,
                money: NokTheme.tl(b.total),
                active: !forceNew && orderId == b.id,
                onTap: () => _switchTo(b.id),
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: _billChip(
              label: '+ Yeni adisyon',
              money: '',
              active: forceNew,
              onTap: _switchToNew,
            ),
          ),
        ],
      ),
    );
  }

  Widget _billChip({
    required String label,
    required String money,
    required bool active,
    required VoidCallback onTap,
  }) {
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        alignment: Alignment.center,
        decoration: BoxDecoration(
            color: active ? NokTheme.orange : Colors.white,
            border: Border.all(color: active ? NokTheme.orange : NokTheme.line),
            borderRadius: BorderRadius.circular(10)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(label,
              style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  color: active ? Colors.white : NokTheme.ink)),
          if (money.isNotEmpty) ...[
            const SizedBox(width: 8),
            Text(money,
                style: TextStyle(
                    fontSize: 13, color: active ? Colors.white : NokTheme.ink3)),
          ],
        ]),
      ),
    );
  }

  /*
   * THE BASKET, AS A BAR THAT OPENS - NOT A PANEL THAT SITS THERE.
   *
   * It was a fixed panel up to 250 pixels tall, pinned under the products, and
   * it appeared the moment the first item was tapped. On a handheld that is
   * between a third and half the screen, permanently, taken away from the one
   * thing the waiter is looking at: the menu. Adding the second item meant
   * scrolling a list that had just been cut in half, and the last product row
   * sat underneath the bar where it could not be tapped at all.
   *
   * Collapsed it is one line - what the order comes to, how many lines, and
   * the button that ends the job. Tap it and it opens over the products;
   * tap it again, or send, and it is gone. Same information, none of the rent.
   */
  Widget _draftPanel() {
    final kalem = draft.length;
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: const Border(top: BorderSide(color: NokTheme.line)),
        boxShadow: [
          if (sepetAcik)
            BoxShadow(color: Colors.black.withValues(alpha: .10), blurRadius: 14, offset: const Offset(0, -4)),
        ],
      ),
      child: SafeArea(
        top: false,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (sepetAcik)
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * .42),
              child: ListView.separated(
                shrinkWrap: true,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                itemCount: draft.length,
                separatorBuilder: (_, __) => const Divider(height: 1, color: NokTheme.line),
                itemBuilder: (_, i) => _draftLine(draft[i]),
              ),
            ),
          /* The bar itself. The whole left side is the handle, because a
             waiter aims at the number, not at a 20 pixel chevron. */
          Row(children: [
            Expanded(
              child: InkWell(
                onTap: () => setState(() => sepetAcik = !sepetAcik),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
                  child: Row(children: [
                    Icon(sepetAcik ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_up,
                        size: 22, color: NokTheme.ink3),
                    const SizedBox(width: 6),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text('Sepet · $kalem kalem',
                            style: const TextStyle(color: NokTheme.ink3, fontSize: 11.5)),
                        Text(NokTheme.tl(draftTotal),
                            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                      ],
                    ),
                  ]),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(0, 8, 12, 8),
              child: SizedBox(
                width: 168,
                height: 46,
                child: FilledButton(
                    onPressed: sending ? null : _send,
                    child: Text(sending ? 'Gonderiliyor...' : 'Mutfaga gonder')),
              ),
            ),
          ]),
        ]),
      ),
    );
  }

  /// Two rows per line, on purpose. One row could not hold a name, a note
  /// button, a stepper and a total on a 5-inch handheld without every one of
  /// them becoming too small to hit while walking.
  Widget _draftLine(DraftLine l) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
              child: Text(l.product.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
          const SizedBox(width: 8),
          Text(NokTheme.tl(l.total),
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        ]),
        const SizedBox(height: 6),
        Row(children: [
          Expanded(child: _noteButton(l)),
          const SizedBox(width: 8),
          _stepper(l),
        ]),
      ]),
    );
  }

  Widget _noteButton(DraftLine l) {
    // flattened to a plain String: a nullable field does not stay promoted
    // through a conditional expression, and Text() takes no nulls
    final String note = l.note ?? '';
    final has = note.isNotEmpty;
    return Align(
      alignment: Alignment.centerLeft,
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => _editNote(l),
        child: Container(
          constraints: const BoxConstraints(minHeight: 42, maxWidth: 200),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
              color: has ? const Color(0xFFFFF1E8) : Colors.white,
              border: Border.all(color: has ? NokTheme.orange : NokTheme.line),
              borderRadius: BorderRadius.circular(8)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.edit_note,
                size: 19, color: has ? NokTheme.orangeDark : NokTheme.ink3),
            const SizedBox(width: 5),
            Flexible(
              child: Text(has ? note : 'Not',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: has ? NokTheme.orangeDark : NokTheme.ink2)),
            ),
          ]),
        ),
      ),
    );
  }

  /// Halves, not wholes.
  ///
  /// Yarim porsiyon is on every menu in the country and the till has always
  /// sent it to the kitchen as a half; the phone stepped in whole units and
  /// printed 1,5 as "2", so a waiter simply could not take the order. Whole
  /// portions stay fast because tapping the product itself still adds one.
  Widget _stepper(DraftLine l) {
    final isHalf = l.qty != l.qty.roundToDouble();
    return Row(mainAxisSize: MainAxisSize.min, children: [
      _stepButton(Icons.remove, false, () {
        setState(() {
          // stepping through the doubled value keeps this exact - repeatedly
          // adding 0.5 to a double eventually prints a quantity nobody typed
          l.qty = ((l.qty * 2).round() - 1) / 2;
          if (l.qty <= 0) draft.remove(l);
        });
      }),
      SizedBox(
        width: 56,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(NokTheme.qty(l.qty),
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  color: isHalf ? NokTheme.orangeDark : NokTheme.ink)),
          if (isHalf)
            const Text('yarim',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 10, height: 1.1, color: NokTheme.orangeDark)),
        ]),
      ),
      _stepButton(Icons.add, true, () {
        setState(() => l.qty = ((l.qty * 2).round() + 1) / 2);
      }),
    ]);
  }

  Widget _stepButton(IconData icon, bool accent, VoidCallback onTap) {
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: onTap,
      child: Container(
        // 46 is the smallest square a gloved thumb hits reliably on a handheld
        width: 46,
        height: 46,
        alignment: Alignment.center,
        decoration: BoxDecoration(
            color: Colors.white,
            border: Border.all(color: accent ? NokTheme.orange : NokTheme.line),
            borderRadius: BorderRadius.circular(10)),
        child: Icon(icon, size: 22, color: accent ? NokTheme.orangeDark : NokTheme.ink),
      ),
    );
  }
}
