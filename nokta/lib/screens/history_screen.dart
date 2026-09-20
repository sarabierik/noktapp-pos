import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../theme.dart';
import '../widgets/bits.dart';
import 'card_screen.dart';

/// Geçmiş — every stamp and every reward, newest first, across every restaurant.
///
/// Grouped by day, because that is how somebody looks for a visit they remember.
/// Nothing here is computed by the app: each line is a row a cashier wrote at a
/// counter and the till mirrored up.
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => HistoryScreenState();
}

class HistoryScreenState extends State<HistoryScreen> {
  List<Movement>? _rows;
  String? _error;

  @override
  void initState() {
    super.initState();
    refresh();
  }

  Future<void> refresh() async {
    try {
      final r = await Api.instance.history();
      if (!mounted) return;
      setState(() { _rows = r; _error = null; });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    }
  }

  /// "14 Eylül 2026" — the heading a day's rows sit under.
  String _day(String? raw) {
    if (raw == null || raw.isEmpty) return '';
    final t = DateTime.tryParse(raw.replaceFirst(' ', 'T'));
    if (t == null) return raw;
    const months = [
      'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
      'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
    ];
    final now = DateTime.now();
    final sameDay = t.year == now.year && t.month == now.month && t.day == now.day;
    if (sameDay) return 'Bugün';
    final y = now.subtract(const Duration(days: 1));
    if (t.year == y.year && t.month == y.month && t.day == y.day) return 'Dün';
    return '${t.day} ${months[t.month - 1]} ${t.year}';
  }

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    if (_error != null && rows == null) {
      return Problem(message: _error!, onRetry: () { setState(() => _error = null); refresh(); });
    }
    if (rows == null) return const Loading();
    if (rows.isEmpty) {
      return RefreshIndicator(
        color: NoktaTheme.orange,
        backgroundColor: NoktaTheme.card,
        onRefresh: refresh,
        child: ListView(children: [
          SizedBox(height: MediaQuery.of(context).size.height * 0.12),
          const Blank(
            icon: Icons.history_rounded,
            title: 'Hareket yok',
            body: 'Bir restoranda pul aldığınızda ya da ödülünüzü kullandığınızda '
                'buraya yazılır.',
          ),
        ]),
      );
    }

    /* Grouped as the list is built rather than into a map first: the rows already
       arrive newest first, so walking them once keeps that order without having
       to sort the groups back into it afterwards. */
    final items = <Widget>[];
    String last = '';
    for (final m in rows) {
      final d = _day(m.happenedAt);
      if (d != last) {
        items.add(Padding(
          padding: EdgeInsets.only(left: 4, top: items.isEmpty ? 4 : 22, bottom: 10),
          child: Text(d.toUpperCase(),
              style: const TextStyle(
                  color: NoktaTheme.text3,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.1)),
        ));
        last = d;
      }
      items.add(Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: NoktaTheme.card,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: NoktaTheme.line),
        ),
        child: MovementRow(m: m),
      ));
    }

    return RefreshIndicator(
      color: NoktaTheme.orange,
      backgroundColor: NoktaTheme.card,
      onRefresh: refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 6, 18, 28),
        children: items,
      ),
    );
  }
}
