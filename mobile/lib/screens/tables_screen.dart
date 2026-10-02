import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../services/session.dart';
import '../services/queue.dart';
import '../theme.dart';
import '../main.dart' show AcilisEkrani;
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

  /// What is typed in the search box. Matches the table's name AND its etiket,
  /// because half the time the waiter knows the guest's name and not the
  /// number - "Ahmet" has to find MS101.
  String arama = '';

  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 20), (_) => _tazele());
  }

  @override
  void dispose() { _timer?.cancel(); super.dispose(); }

  /*
   * THE REFRESH THAT WAS COSTING THE MOST.
   *
   * Every twenty seconds this screen called /bootstrap - zones, tables, the
   * WHOLE MENU and the permission list - and rebuilt all of it. On a bar with
   * four hundred products that is a large JSON body parsed on the main thread
   * three times a minute, on a handset, while the waiter is trying to scroll.
   * It is a good part of "the app is slow".
   *
   * The menu does not change during service. The silent refresh asks for the
   * floor plan alone now; the full bootstrap runs when the screen opens and
   * when the waiter pulls to refresh.
   */
  Future<void> _tazele() async {
    try {
      final res = await Api.instance.call('GET', '/api/mobile/tables');
      if (!mounted) return;
      setState(() {
        tables = (res['tables'] as List).map((t) => TableInfo.fromJson(t)).toList();
        final z = res['zones'];
        if (z is List && z.isNotEmpty) zones = z.map((e) => Zone.fromJson(e)).toList();
        viaRelay = Api.instance.lastCallUsedRelay;
      });
    } catch (_) {
      /* a missed tick is not worth a message - the next one is 20 seconds
         away and the error box belongs to the full load */
    }
    final n = await OfflineQueue.count();
    if (mounted && n != queued) setState(() => queued = n);
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() { loading = true; error = null; });
    try {
      final flushed = await OfflineQueue.flush();
      if (flushed.sent > 0 && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${flushed.sent} bekleyen sipariş kasaya iletildi'),
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
      if (mounted) setState(() { error = 'Kasaya ulaşılamadı'; loading = false; });
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
        /*
         * THE MENU, AND THE TWO THINGS THAT WERE NOWHERE.
         *
         * There was no way out of this app. Once a phone was paired it stayed
         * paired, with no sign of who it was paired AS and no way to hand the
         * handset to the next shift - the only exit was to uninstall it. And
         * the till's address, which a waiter needs about twice a year, was
         * being asked for on the pairing screen, which he sees every day.
         *
         * Both belong here: behind one tap, out of the way, always findable.
         */
        leading: Builder(
          builder: (c) => IconButton(
            icon: const Icon(Icons.menu),
            tooltip: 'Menu',
            onPressed: () => _menu(c),
          ),
        ),
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
          preferredSize: const Size.fromHeight(56),
          child: Container(
            height: 56,
            color: Colors.white,
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
            /*
             * A DROPDOWN AND A SEARCH BOX, NOT A ROW OF CHIPS.
             *
             * The chips ate a whole row of the screen to show four words, and
             * a restaurant with eight zones had to scroll sideways to reach
             * the garden. The dropdown says the same thing in a quarter of the
             * width, and the space that buys goes to search - which is the
             * control a waiter actually needs, because he is looking for one
             * table out of sixty while walking.
             */
            child: Row(children: [
              Container(
                height: 40,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                decoration: BoxDecoration(
                    border: Border.all(color: NokTheme.line),
                    borderRadius: BorderRadius.circular(10)),
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<int?>(
                    value: zoneId,
                    isDense: true,
                    borderRadius: BorderRadius.circular(10),
                    style: const TextStyle(fontSize: 14, color: NokTheme.ink, fontWeight: FontWeight.w600),
                    items: [
                      const DropdownMenuItem<int?>(value: null, child: Text('Tumu')),
                      for (final z in zones) DropdownMenuItem<int?>(value: z.id, child: Text(z.name)),
                    ],
                    onChanged: (v) => setState(() => zoneId = v),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: SizedBox(
                  height: 40,
                  child: TextField(
                    onChanged: (v) => setState(() => arama = v.trim().toLowerCase()),
                    textInputAction: TextInputAction.search,
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: 'Masa veya etiket ara',
                      hintStyle: const TextStyle(fontSize: 14, color: NokTheme.ink3),
                      prefixIcon: const Icon(Icons.search, size: 19, color: NokTheme.ink3),
                      contentPadding: const EdgeInsets.symmetric(vertical: 8),
                      border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(color: NokTheme.line)),
                      enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(color: NokTheme.line)),
                    ),
                  ),
                ),
              ),
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
              child: const Text('Restoran ağı dışındasınız — istekler internet üzerinden iletiliyor.',
                  style: TextStyle(color: NokTheme.orangeDark, fontSize: 12.5), textAlign: TextAlign.center))
          : null,
    );
  }

  /// Who this phone is, where the till is, and the way out.
  Future<void> _menu(BuildContext c) async {
    final s = Session.instance;
    await showModalBottomSheet(
      context: c,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (sheetCtx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 16, 18, 10),
            child: Row(children: [
              Container(
                width: 42, height: 42,
                decoration: BoxDecoration(
                    color: const Color(0xFFFFF1E8), borderRadius: BorderRadius.circular(12)),
                child: const Icon(Icons.person_outline, color: NokTheme.orangeDark),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(s.userName.isEmpty ? 'NOKTApp Garson' : s.userName,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                  Text(Api.instance.deviceName,
                      style: const TextStyle(fontSize: 12.5, color: NokTheme.ink3)),
                ]),
              ),
            ]),
          ),
          const Divider(height: 1, color: NokTheme.line),
          ListTile(
            leading: const Icon(Icons.wifi_tethering, color: NokTheme.ink2),
            title: const Text('Kasa adresi'),
            subtitle: Text(Api.instance.lanBase ?? 'aranıyor',
                style: const TextStyle(fontSize: 12)),
            onTap: () { Navigator.pop(sheetCtx); _kasaAdresi(); },
          ),
          ListTile(
            leading: const Icon(Icons.refresh, color: NokTheme.ink2),
            title: const Text('Kasayı tekrar ara'),
            onTap: () async {
              Navigator.pop(sheetCtx);
              await Api.instance.locate(force: true);
              if (mounted) _load();
            },
          ),
          ListTile(
            leading: const Icon(Icons.logout, color: NokTheme.orangeDark),
            title: const Text('Çıkış yap',
                style: TextStyle(color: NokTheme.orangeDark, fontWeight: FontWeight.w600)),
            subtitle: const Text('Telefonun kasa ile bağlantısı kesilir',
                style: TextStyle(fontSize: 12)),
            onTap: () { Navigator.pop(sheetCtx); _cikis(); },
          ),
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  /// Typing the till's address by hand - the rare case, behind the menu
  /// instead of on the screen a waiter sees every morning.
  Future<void> _kasaAdresi() async {
    final ctrl = TextEditingController(text: Api.instance.lanBase ?? '');
    final kaydet = await showDialog<bool>(
      context: context,
      builder: (dCtx) => AlertDialog(
        title: const Text('Kasa adresi'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Normalde telefon kasayı kendi bulur. Bulamıyorsa kasadaki '
              '"Telefon bağla" ekranında yazan adresi buraya yazın.',
              style: TextStyle(fontSize: 12.5, color: NokTheme.ink3)),
          const SizedBox(height: 12),
          TextField(
            controller: ctrl,
            autofocus: true,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(hintText: 'http://192.168.1.40:7451'),
          ),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, false), child: const Text('Vazgeç')),
          FilledButton(onPressed: () => Navigator.pop(dCtx, true), child: const Text('Kaydet')),
        ],
      ),
    );
    if (kaydet != true || !mounted) return;
    final ok = await Api.instance.setManualBase(ctrl.text);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(ok ? 'Kasa bulundu' : 'Bu adreste kasa yanıt vermedi'),
      backgroundColor: ok ? NokTheme.ok : NokTheme.orangeDark,
    ));
    if (ok) _load();
  }

  /// Out. Asked properly, because it un-pairs: the next person has to scan a
  /// new symbol at the till, and a waiter who taps it by accident in the
  /// middle of service has just lost his handset for ten minutes.
  Future<void> _cikis() async {
    final n = await OfflineQueue.count();
    final yes = await showDialog<bool>(
      context: context,
      builder: (dCtx) => AlertDialog(
        title: const Text('Çıkış yap'),
        content: Text(n > 0
            ? '$n sipariş henüz kasaya iletilmedi. Çıkarsanız bu siparişler '
              'gönderilemez. Önce bağlantıyı bekleyin.'
            : 'Bu telefonun kasa ile bağlantısı kesilecek. Tekrar bağlanmak için '
              'kasadaki karekodu okutmanız gerekir.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, false), child: const Text('Vazgeç')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: NokTheme.orangeDark),
            onPressed: () => Navigator.pop(dCtx, true),
            child: const Text('Çıkış yap'),
          ),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    await Api.instance.forget();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => const PairScreen()), (_) => false);
  }

  Widget _plan() {
    if (loading) return const AcilisEkrani(mesaj: 'Masalar yükleniyor');
    if (error != null) return _errorBox();
    var list = zoneId == null ? tables : tables.where((t) => t.zoneId == zoneId).toList();
    if (arama.isNotEmpty) {
      list = list
          .where((t) =>
              t.name.toLowerCase().contains(arama) || t.etiket.toLowerCase().contains(arama))
          .toList();
    }
    if (list.isEmpty) {
      return Center(
        child: Text(arama.isEmpty ? 'Bu bölümde masa yok' : '"$arama" bulunamadı',
            style: const TextStyle(color: NokTheme.ink3)),
      );
    }
    final dolu = list.where((t) => t.busy).length;
    return Column(children: [
      Expanded(
        child: RefreshIndicator(
          onRefresh: () => _load(),
          color: NokTheme.orange,
          /*
           * THREE COLUMNS, NOT TWO.
           *
           * Two columns of tall cards showed eight tables on a handset, so a
           * sixty table restaurant was four screens of scrolling and no waiter
           * could see his section at once - which is the entire job of a floor
           * plan. Three columns of solid tiles show fifteen, status reads as
           * colour from across the room, and the numbers that matter - what
           * the table owes, how long it has been sitting, what it is called -
           * all still fit.
           */
          child: GridView.builder(
            padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 3, childAspectRatio: 0.92, crossAxisSpacing: 8, mainAxisSpacing: 8),
            itemCount: list.length,
            itemBuilder: (_, i) => _tableCard(list[i]),
          ),
        ),
      ),
      /* The floor in one line. An owner wants this number and used to have to
         add it up off the screen. */
      Container(
        width: double.infinity,
        decoration: const BoxDecoration(
            color: Colors.white, border: Border(top: BorderSide(color: NokTheme.line))),
        padding: const EdgeInsets.fromLTRB(16, 11, 16, 11),
        child: Row(children: [
          Text('$dolu dolu · ${list.length - dolu} boş',
              style: const TextStyle(color: NokTheme.ink3, fontSize: 13)),
          const Spacer(),
          Text(NokTheme.tl(list.fold<double>(0, (a, t) => a + t.openTotal)),
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        ]),
      ),
    ]);
  }

  Widget _errorBox() => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.wifi_off, size: 40, color: NokTheme.ink3),
            const SizedBox(height: 14),
            Text(error!, textAlign: TextAlign.center, style: const TextStyle(color: NokTheme.ink2)),
            const SizedBox(height: 8),
            const Text('Aldığınız siparişler telefonda saklanır ve bağlantı gelince otomatik iletilir.',
                textAlign: TextAlign.center, style: TextStyle(color: NokTheme.ink3, fontSize: 13)),
            const SizedBox(height: 18),
            OutlinedButton(onPressed: () async { await Api.instance.locate(force: true); _load(); },
                child: const Text('Kasayı tekrar ara')),
          ]),
        ),
      );

  /// "Bu masaya etiket ver".
  ///
  /// One field, the labels this restaurant already uses as chips, and one
  /// switch that decides whether the words belong to the guests or to the
  /// table. Everything else - who typed it, when - the till records by itself.
  Future<void> _etiketVer(TableInfo t) async {
    final ctrl = TextEditingController(text: t.etiket);
    var kalici = t.etiketKalici;
    var kaydediliyor = false;
    final gecmis = await Api.instance.etiketler();
    if (!mounted) return;

    final sonuc = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (sheetCtx) => StatefulBuilder(builder: (sheetCtx, setSheet) {
        Future<void> kaydet(String? deger) async {
          if (kaydediliyor) return;
          setSheet(() => kaydediliyor = true);
          try {
            await Api.instance.setEtiket(t.id, deger ?? ctrl.text, kalici: kalici);
            if (sheetCtx.mounted) Navigator.of(sheetCtx).pop(true);
          } catch (e) {
            setSheet(() => kaydediliyor = false);
            if (sheetCtx.mounted) {
              ScaffoldMessenger.of(sheetCtx).showSnackBar(
                  SnackBar(content: Text(e.toString()), backgroundColor: NokTheme.orangeDark));
            }
          }
        }

        return Padding(
          padding: EdgeInsets.only(
              left: 18, right: 18, top: 10,
              bottom: MediaQuery.of(sheetCtx).viewInsets.bottom + 18),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(child: Container(width: 38, height: 4, margin: const EdgeInsets.only(bottom: 14),
                  decoration: BoxDecoration(color: NokTheme.line, borderRadius: BorderRadius.circular(2)))),
              Text('Masa etiketi · ${t.name}',
                  style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              const Text('Masanın üzerinde ve bütün telefonlarda görünür.',
                  style: TextStyle(color: NokTheme.ink3, fontSize: 12.5)),
              const SizedBox(height: 14),
              TextField(
                controller: ctrl,
                autofocus: true,
                textCapitalization: TextCapitalization.words,
                maxLength: 60,
                decoration: const InputDecoration(
                  hintText: 'Ahmet Bey, doğum günü, rezerve 20:30...',
                  counterText: '',
                ),
                onSubmitted: (v) => kaydet(v),
              ),
              if (gecmis.isNotEmpty) ...[
                const SizedBox(height: 10),
                const Text('HIZLI ETİKET',
                    style: TextStyle(fontSize: 10.5, letterSpacing: .7, color: NokTheme.ink3)),
                const SizedBox(height: 6),
                Wrap(spacing: 7, runSpacing: 7, children: [
                  for (final g in gecmis.take(10))
                    ActionChip(
                      label: Text(g, style: const TextStyle(fontSize: 12.5)),
                      onPressed: () => setSheet(() => ctrl.text = g),
                    ),
                ]),
              ],
              const SizedBox(height: 14),
              /* The one decision worth a switch. Left off, the label is the
                 party's and dies with their bill - which is what a customer
                 name must do, or tomorrow's guests are greeted by yesterday's
                 name. Turned on, it is the table's own and stays. */
              SwitchListTile.adaptive(
                value: !kalici,
                onChanged: kaydediliyor ? null : (v) => setSheet(() => kalici = !v),
                activeColor: NokTheme.orange,
                contentPadding: EdgeInsets.zero,
                title: const Text('Masa boşalınca sil',
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                subtitle: const Text(
                    'Kapatırsanız VIP, Rezerve, Sigara içilir gibi kalıcı etiket olur.',
                    style: TextStyle(fontSize: 11.5, color: NokTheme.ink3)),
              ),
              const SizedBox(height: 6),
              Row(children: [
                if (t.etiket.isNotEmpty)
                  TextButton(
                    onPressed: kaydediliyor ? null : () => kaydet(''),
                    child: const Text('Sil', style: TextStyle(color: NokTheme.orangeDark)),
                  ),
                const Spacer(),
                TextButton(
                    onPressed: kaydediliyor ? null : () => Navigator.of(sheetCtx).pop(false),
                    child: const Text('Vazgeç')),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: kaydediliyor ? null : () => kaydet(null),
                  child: kaydediliyor
                      ? const SizedBox(width: 16, height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Kaydet'),
                ),
              ]),
            ]),
        );
      }),
    );

    if (sonuc == true && mounted) _load();
  }

  Widget _tableCard(TableInfo t) {
    final busy = t.busy;
    final sure = t.sure;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => _openTable(t),
      /* Long press labels the table. The tag in the corner does the same for
         anyone who never discovers a long press. */
      onLongPress: () => _etiketVer(t),
      child: Container(
        decoration: BoxDecoration(
          gradient: busy
              ? const LinearGradient(
                  begin: Alignment.topLeft, end: Alignment.bottomRight,
                  colors: [NokTheme.orange, NokTheme.orangeDark])
              : null,
          color: busy ? null : Colors.white,
          border: Border.all(color: busy ? NokTheme.orangeDark : NokTheme.line),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Stack(children: [
          // corners: how many bills, and how long they have been sitting
          Positioned(
            left: 6, top: 5,
            child: Text(busy && t.openBills > 1 ? '${t.openBills} adisyon' : '',
                style: TextStyle(
                    fontSize: 9.5,
                    fontWeight: FontWeight.w600,
                    color: busy ? Colors.white.withValues(alpha: .92) : NokTheme.ink3)),
          ),
          Positioned(
            right: 6, top: 5,
            child: Text(sure,
                style: TextStyle(
                    fontSize: 9.5,
                    fontWeight: FontWeight.w600,
                    color: busy ? Colors.white.withValues(alpha: .92) : NokTheme.ink3)),
          ),
          Positioned(
            right: 4, bottom: 4,
            child: Icon(Icons.sell_outlined,
                size: 14,
                color: busy
                    ? Colors.white.withValues(alpha: t.etiket.isEmpty ? .45 : .95)
                    : (t.etiket.isEmpty ? const Color(0xFFC9C9CE) : NokTheme.orangeDark)),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 20, 6, 6),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Icon(Icons.table_restaurant_outlined,
                    size: 17, color: busy ? Colors.white : const Color(0xFFC9C9CE)),
                const SizedBox(height: 3),
                Text(t.name,
                    maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center,
                    style: TextStyle(
                        fontSize: 13.5, fontWeight: FontWeight.w700,
                        color: busy ? Colors.white : NokTheme.ink)),
                if (t.etiket.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    if (t.etiketKalici)
                      Icon(Icons.push_pin, size: 9,
                          color: busy ? Colors.white : NokTheme.orangeDark),
                    Flexible(
                      child: Text(t.etiket,
                          maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center,
                          style: TextStyle(
                              fontSize: 10.5, fontWeight: FontWeight.w700,
                              color: busy ? Colors.white : NokTheme.orangeDark)),
                    ),
                  ]),
                ],
                const SizedBox(height: 3),
                Text(busy ? NokTheme.tl(t.openTotal) : 'boş',
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: busy ? 12.5 : 11,
                        fontWeight: busy ? FontWeight.w700 : FontWeight.w400,
                        color: busy ? Colors.white : NokTheme.ink3)),
              ],
            ),
          ),
        ]),
      ),
    );
  }
}
