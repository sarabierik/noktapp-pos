import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';

/// One campaign, drawn the way a paper stamp card works.
///
/// The dots are the point. A progress bar tells a guest a percentage; a row of
/// stamps tells them "two more" without reading anything, which is the question
/// they actually have. Above about fourteen stamps the dots stop being legible
/// at this width, so past that the card falls back to a bar and a number - a
/// wrong-looking row of specks would be worse than either.
class StampCard extends StatelessWidget {
  final LoyaltyCard card;
  final VoidCallback? onTap;
  final bool showRestaurant;

  const StampCard({super.key, required this.card, this.onTap, this.showRestaurant = true});

  @override
  Widget build(BuildContext context) {
    final ready = card.hasReward;
    return Material(
      color: NoktaTheme.card,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(
              color: ready ? NoktaTheme.orange.withValues(alpha: 0.55) : NoktaTheme.line,
              width: ready ? 1.4 : 1,
            ),
          ),
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (showRestaurant)
                          Text(
                            card.restaurant.toUpperCase(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                color: NoktaTheme.text3,
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                letterSpacing: 1.1),
                          ),
                        if (showRestaurant) const SizedBox(height: 6),
                        Text(
                          card.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              color: NoktaTheme.text,
                              fontSize: 18,
                              height: 1.2,
                              fontWeight: FontWeight.w700),
                        ),
                      ],
                    ),
                  ),
                  if (ready) const SizedBox(width: 10),
                  if (ready) const _ReadyPill(),
                ],
              ),
              const SizedBox(height: 16),
              if (card.target <= 14)
                _StampRow(target: card.target, filled: card.progress)
              else
                _Bar(fraction: card.fraction),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      ready
                          ? card.rewardText
                          : (card.remaining == 1
                              ? '1 tane daha, sonra ${card.rewardText.toLowerCase()}'
                              : '${card.remaining} tane daha'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: ready ? NoktaTheme.orange : NoktaTheme.text2,
                        fontSize: 14,
                        fontWeight: ready ? FontWeight.w700 : FontWeight.w500,
                      ),
                    ),
                  ),
                  Text(
                    '${card.progress}/${card.target}',
                    style: const TextStyle(
                        color: NoktaTheme.text3, fontSize: 14, fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ReadyPill extends StatelessWidget {
  const _ReadyPill();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: NoktaTheme.orange,
        borderRadius: BorderRadius.circular(999),
      ),
      child: const Text('ÖDÜL HAZIR',
          style: TextStyle(
              color: Colors.white, fontSize: 10, fontWeight: FontWeight.w800, letterSpacing: 0.8)),
    );
  }
}

class _StampRow extends StatelessWidget {
  final int target;
  final int filled;
  const _StampRow({required this.target, required this.filled});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      /* The dots size themselves to the width they have. A fixed diameter looks
         right on one phone and overflows on the next, and an overflow here is a
         yellow-and-black stripe across the middle of the card. */
      const gap = 8.0;
      /* toDouble() because num.clamp is declared to return num, and a num in a
         Container's width is a compile error rather than a rounding bug. */
      final d = ((box.maxWidth - gap * (target - 1)) / target).clamp(8.0, 26.0).toDouble();
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: List<Widget>.generate(target, (i) {
          final on = i < filled;
          return Container(
            width: d,
            height: d,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: on ? NoktaTheme.orange : NoktaTheme.empty,
              border: on ? null : Border.all(color: NoktaTheme.line),
            ),
          );
        }),
      );
    });
  }
}

class _Bar extends StatelessWidget {
  final double fraction;
  const _Bar({required this.fraction});

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(999),
      child: SizedBox(
        height: 10,
        child: LinearProgressIndicator(
          value: fraction,
          backgroundColor: NoktaTheme.empty,
          valueColor: const AlwaysStoppedAnimation<Color>(NoktaTheme.orange),
        ),
      ),
    );
  }
}
