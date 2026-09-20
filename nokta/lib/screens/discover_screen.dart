import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../theme.dart';
import '../widgets/bits.dart';

/// Keşfet — the campaigns running at NOKTApp restaurants.
///
/// This screen exists because of what the app looks like on the day somebody
/// installs it: no cards, no history, and nothing explaining what it is for.
/// A list of real campaigns at real restaurants answers "where do I use this"
/// without a tutorial.
///
/// Campaigns the guest is already collecting are marked rather than hidden -
/// seeing "siz de topluyorsunuz" next to a card they hold is how the two screens
/// connect.
class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key});

  @override
  State<DiscoverScreen> createState() => DiscoverScreenState();
}

class DiscoverScreenState extends State<DiscoverScreen> {
  List<Place>? _places;
  String? _error;
  final _find = TextEditingController();

  @override
  void initState() {
    super.initState();
    refresh();
  }

  @override
  void dispose() {
    _find.dispose();
    super.dispose();
  }

  Future<void> refresh() async {
    try {
      final p = await Api.instance.places();
      p.sort((a, b) => a.restaurant.compareTo(b.restaurant));
      if (!mounted) return;
      setState(() { _places = p; _error = null; });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    }
  }

  List<Place> get _shown {
    final all = _places ?? const <Place>[];
    final q = _find.text.trim().toLowerCase();
    if (q.isEmpty) return all;
    return all.where((p) {
      if (p.restaurant.toLowerCase().contains(q)) return true;
      if ((p.city ?? '').toLowerCase().contains(q)) return true;
      return p.campaigns.any((c) => c.title.toLowerCase().contains(q));
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null && _places == null) {
      return Problem(message: _error!, onRetry: () { setState(() => _error = null); refresh(); });
    }
    if (_places == null) return const Loading();

    if (_places!.isEmpty) {
      return RefreshIndicator(
        color: NoktaTheme.orange,
        backgroundColor: NoktaTheme.card,
        onRefresh: refresh,
        child: ListView(children: [
          SizedBox(height: MediaQuery.of(context).size.height * 0.12),
          const Blank(
            icon: Icons.storefront_outlined,
            title: 'Şu an listelenecek kampanya yok',
            body: 'Restoranlar kampanyalarını kasadan tanımlar. '
                'Tanımlandığı anda burada görünür.',
          ),
        ]),
      );
    }

    final shown = _shown;
    return RefreshIndicator(
      color: NoktaTheme.orange,
      backgroundColor: NoktaTheme.card,
      onRefresh: refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 6, 18, 28),
        children: [
          TextField(
            controller: _find,
            onChanged: (_) => setState(() {}),
            style: const TextStyle(color: NoktaTheme.text, fontSize: 15),
            decoration: InputDecoration(
              hintText: 'Restoran, şehir veya kampanya ara',
              prefixIcon: const Icon(Icons.search_rounded, color: NoktaTheme.text3, size: 20),
              suffixIcon: _find.text.isEmpty
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.close_rounded, color: NoktaTheme.text3, size: 19),
                      onPressed: () => setState(() => _find.clear()),
                    ),
            ),
          ),
          const SizedBox(height: 18),
          if (shown.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 40),
              child: Text('Aramanıza uyan bir şey bulamadım.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: NoktaTheme.text2, fontSize: 14)),
            ),
          for (final p in shown) ...[
            Container(
              margin: const EdgeInsets.only(bottom: 12),
              decoration: BoxDecoration(
                color: NoktaTheme.card,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: NoktaTheme.line),
              ),
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(p.restaurant,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                color: NoktaTheme.text,
                                fontSize: 16.5,
                                fontWeight: FontWeight.w700)),
                      ),
                      if (p.city != null)
                        Text(p.city!,
                            style: const TextStyle(color: NoktaTheme.text3, fontSize: 13)),
                    ],
                  ),
                  const SizedBox(height: 12),
                  for (final c in p.campaigns)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            margin: const EdgeInsets.only(top: 5),
                            width: 7,
                            height: 7,
                            decoration: const BoxDecoration(
                                color: NoktaTheme.orange, shape: BoxShape.circle),
                          ),
                          const SizedBox(width: 11),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(c.title,
                                    style: const TextStyle(
                                        color: NoktaTheme.text,
                                        fontSize: 14.5,
                                        fontWeight: FontWeight.w600)),
                                const SizedBox(height: 2),
                                Text(
                                    [
                                      if (c.productName != null) c.productName!,
                                      '${c.target} adet',
                                      c.rewardText,
                                    ].join(' · '),
                                    style: const TextStyle(
                                        color: NoktaTheme.text3, fontSize: 12.5, height: 1.4)),
                              ],
                            ),
                          ),
                          if (c.alreadyMine) const SizedBox(width: 8),
                          if (c.alreadyMine)
                            Container(
                              margin: const EdgeInsets.only(top: 2),
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(
                                color: NoktaTheme.orange.withValues(alpha: 0.14),
                                borderRadius: BorderRadius.circular(999),
                                border: Border.all(
                                    color: NoktaTheme.orange.withValues(alpha: 0.4)),
                              ),
                              child: const Text('TOPLUYORSUNUZ',
                                  style: TextStyle(
                                      color: NoktaTheme.orange,
                                      fontSize: 9.5,
                                      fontWeight: FontWeight.w800,
                                      letterSpacing: 0.6)),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
