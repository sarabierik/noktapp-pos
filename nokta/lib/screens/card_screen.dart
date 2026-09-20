import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../theme.dart';
import '../widgets/bits.dart';
import '../widgets/stamp_card.dart';

/// One card, its campaign in full, and every stamp that built it.
///
/// The card arrives from the list already, so it is drawn immediately and the
/// movements are fetched behind it. A guest who taps a card and watches a
/// spinner where the card was is being made to wait for something the app
/// already knew.
class CardScreen extends StatefulWidget {
  final LoyaltyCard card;
  const CardScreen({super.key, required this.card});

  @override
  State<CardScreen> createState() => _CardScreenState();
}

class _CardScreenState extends State<CardScreen> {
  late LoyaltyCard _card = widget.card;
  List<Movement>? _events;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await Api.instance.card(widget.card.tenantId, widget.card.programId);
      if (!mounted) return;
      setState(() { _card = r.card; _events = r.events; _error = null; });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() { _events = const []; _error = e.message; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final events = _events;
    return Scaffold(
      appBar: AppBar(title: Text(_card.restaurant)),
      body: RefreshIndicator(
        color: NoktaTheme.orange,
        backgroundColor: NoktaTheme.card,
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 6, 18, 28),
          children: [
            StampCard(card: _card, showRestaurant: false),
            const SizedBox(height: 20),
            Panel(
              title: 'Kampanya',
              children: [
                Line(icon: Icons.emoji_events_outlined, label: 'Ödül', value: _card.rewardText),
                Line(
                    icon: Icons.numbers_rounded,
                    label: 'Hedef',
                    value: '${_card.target} adet'),
                if (_card.productName != null)
                  Line(
                      icon: Icons.restaurant_menu_rounded,
                      label: 'Ürün',
                      value: _card.productName),
                if (_card.productPrice != null && _card.productPrice! > 0)
                  Line(
                      icon: Icons.sell_outlined,
                      label: 'Ödülün değeri',
                      value: NoktaTheme.tl(_card.productPrice!)),
                Line(
                    icon: Icons.redeem_outlined,
                    label: 'Kullandığınız ödül',
                    value: '${_card.rewardsUsed}'),
                if (!_card.active)
                  const Line(
                      icon: Icons.pause_circle_outline_rounded,
                      label: 'Durum',
                      value: 'Kampanya durdurulmuş'),
              ],
            ),
            const SizedBox(height: 22),
            const Padding(
              padding: EdgeInsets.only(left: 4, bottom: 10),
              child: Text('HAREKETLER',
                  style: TextStyle(
                      color: NoktaTheme.text3,
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.1)),
            ),
            if (events == null)
              const Padding(padding: EdgeInsets.symmetric(vertical: 28), child: Loading())
            else if (events.isEmpty)
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: NoktaTheme.card,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: NoktaTheme.line),
                ),
                child: Text(
                    _error ??
                        'Bu kart için henüz kayıtlı hareket yok. '
                            'Restoranda pul aldığınızda burada görünür.',
                    style: const TextStyle(
                        color: NoktaTheme.text2, fontSize: 13.5, height: 1.5)),
              )
            else
              Container(
                decoration: BoxDecoration(
                  color: NoktaTheme.card,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: NoktaTheme.line),
                ),
                child: Column(
                  children: [
                    for (var i = 0; i < events.length; i++) ...[
                      if (i > 0)
                        const Padding(
                          padding: EdgeInsets.only(left: 53),
                          child: Divider(height: 1, thickness: 1, color: NoktaTheme.line),
                        ),
                      MovementRow(m: events[i], showRestaurant: false),
                    ],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// A single line of history. Shared with Geçmiş, so the two screens cannot
/// drift into describing the same event differently.
class MovementRow extends StatelessWidget {
  final Movement m;
  final bool showRestaurant;
  const MovementRow({super.key, required this.m, this.showRestaurant = true});

  @override
  Widget build(BuildContext context) {
    final reward = m.isReward;
    final title = reward
        ? 'Ödül kullanıldı'
        : (m.qty > 1 ? '${m.qty} pul' : '1 pul');
    final parts = <String>[
      if (showRestaurant) m.restaurant,
      if (m.productName != null) m.productName!,
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 15),
      child: Row(
        children: [
          Container(
            width: 35,
            height: 35,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: reward ? NoktaTheme.orange : NoktaTheme.empty,
              border: reward ? null : Border.all(color: NoktaTheme.line),
            ),
            alignment: Alignment.center,
            child: Icon(reward ? Icons.emoji_events_rounded : Icons.add_rounded,
                size: 18, color: reward ? Colors.white : NoktaTheme.text2),
          ),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: TextStyle(
                        color: reward ? NoktaTheme.orange : NoktaTheme.text,
                        fontSize: 15,
                        fontWeight: FontWeight.w600)),
                if (parts.isNotEmpty) const SizedBox(height: 3),
                if (parts.isNotEmpty)
                  Text(parts.join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: NoktaTheme.text3, fontSize: 12.5)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(trWhen(m.happenedAt),
              style: const TextStyle(color: NoktaTheme.text3, fontSize: 12.5)),
        ],
      ),
    );
  }
}
