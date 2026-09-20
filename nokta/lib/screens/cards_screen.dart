import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../theme.dart';
import '../widgets/bits.dart';
import '../widgets/stamp_card.dart';
import 'card_screen.dart';

/// Kartlarım — the home screen, and the reason the app exists.
///
/// Grouped by restaurant, and a restaurant with a finished card floats to the
/// top: "you have a free pizza waiting at X" is the only thing on this screen
/// that needs acting on today, so it does not get to hide under three cards that
/// are halfway done.
class CardsScreen extends StatefulWidget {
  final VoidCallback onShowCode;
  const CardsScreen({super.key, required this.onShowCode});

  @override
  State<CardsScreen> createState() => CardsScreenState();
}

class CardsScreenState extends State<CardsScreen> {
  List<CardGroup>? _groups;
  String? _error;

  @override
  void initState() {
    super.initState();
    refresh();
  }

  Future<void> refresh() async {
    try {
      final g = await Api.instance.cards();
      g.sort((a, b) {
        final ar = a.cards.any((c) => c.hasReward) ? 0 : 1;
        final br = b.cards.any((c) => c.hasReward) ? 0 : 1;
        if (ar != br) return ar - br;
        return a.restaurant.compareTo(b.restaurant);
      });
      if (!mounted) return;
      setState(() { _groups = g; _error = null; });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final groups = _groups;
    if (_error != null && groups == null) {
      return Problem(message: _error!, onRetry: () { setState(() => _error = null); refresh(); });
    }
    if (groups == null) return const Loading();

    if (groups.isEmpty) {
      return RefreshIndicator(
        color: NoktaTheme.orange,
        backgroundColor: NoktaTheme.card,
        onRefresh: refresh,
        child: ListView(
          children: [
            SizedBox(height: MediaQuery.of(context).size.height * 0.10),
            const Blank(
              icon: Icons.style_outlined,
              title: 'Henüz kartınız yok',
              body: 'Bir NOKTApp restoranında karekodunuzu okutun. '
                  'İlk pulunuzu aldığınız anda kartınız burada görünür.',
            ),
            Center(
              child: TextButton.icon(
                onPressed: widget.onShowCode,
                icon: const Icon(Icons.qr_code_2_rounded, size: 20),
                label: const Text('Karekodumu göster'),
              ),
            ),
          ],
        ),
      );
    }

    final ready = groups
        .expand((g) => g.cards)
        .fold<int>(0, (sum, c) => sum + c.rewardsAvailable);

    return RefreshIndicator(
      color: NoktaTheme.orange,
      backgroundColor: NoktaTheme.card,
      onRefresh: refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 6, 18, 28),
        children: [
          if (ready > 0) _ReadyBanner(count: ready, onShowCode: widget.onShowCode),
          if (ready > 0) const SizedBox(height: 22),
          for (final g in groups) ...[
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 10),
              child: Row(
                children: [
                  Expanded(
                    child: Text(g.restaurant,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            color: NoktaTheme.text,
                            fontSize: 17,
                            fontWeight: FontWeight.w700,
                            letterSpacing: -0.2)),
                  ),
                  if (g.city != null)
                    Text(g.city!,
                        style: const TextStyle(color: NoktaTheme.text3, fontSize: 13)),
                ],
              ),
            ),
            for (final c in g.cards) ...[
              StampCard(
                card: c,
                showRestaurant: false,
                onTap: () async {
                  await Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => CardScreen(card: c)));
                  if (mounted) refresh();
                },
              ),
              const SizedBox(height: 12),
            ],
            const SizedBox(height: 14),
          ],
        ],
      ),
    );
  }
}

class _ReadyBanner extends StatelessWidget {
  final int count;
  final VoidCallback onShowCode;
  const _ReadyBanner({required this.count, required this.onShowCode});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [NoktaTheme.orange, NoktaTheme.orangeDark],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(count == 1 ? 'Bir ödülünüz hazır' : '$count ödülünüz hazır',
              style: const TextStyle(
                  color: Colors.white, fontSize: 19, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          const Text('Restoranda karekodunuzu okutun, kasa ödülü hesabınızdan düşer.',
              style: TextStyle(color: Colors.white, fontSize: 13.5, height: 1.4)),
          const SizedBox(height: 14),
          SizedBox(
            height: 44,
            child: FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: NoktaTheme.orangeDark,
                minimumSize: const Size(0, 44),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                textStyle: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700),
              ),
              onPressed: onShowCode,
              icon: const Icon(Icons.qr_code_2_rounded, size: 19),
              label: const Text('Karekodu göster'),
            ),
          ),
        ],
      ),
    );
  }
}
