import 'package:flutter/material.dart';
import '../theme.dart';

/// The three states every list screen has, so none of them invents its own.
///
/// An empty screen with nothing on it is the single most common way an app
/// looks broken when it is working perfectly, so "empty" here always carries a
/// sentence saying what would put something there.
class Blank extends StatelessWidget {
  final IconData icon;
  final String title;
  final String body;
  final String? actionLabel;
  final VoidCallback? onAction;

  const Blank({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(32, 24, 32, 48),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 76,
              height: 76,
              decoration: BoxDecoration(
                color: NoktaTheme.card,
                shape: BoxShape.circle,
                border: Border.all(color: NoktaTheme.line),
              ),
              child: Icon(icon, color: NoktaTheme.text3, size: 34),
            ),
            const SizedBox(height: 22),
            Text(title,
                textAlign: TextAlign.center,
                style: const TextStyle(
                    color: NoktaTheme.text, fontSize: 19, fontWeight: FontWeight.w700)),
            const SizedBox(height: 10),
            Text(body,
                textAlign: TextAlign.center,
                style: const TextStyle(color: NoktaTheme.text2, fontSize: 14, height: 1.5)),
            if (actionLabel != null) const SizedBox(height: 22),
            if (actionLabel != null)
              FilledButton(onPressed: onAction, child: Text(actionLabel!)),
          ],
        ),
      ),
    );
  }
}

class Loading extends StatelessWidget {
  const Loading({super.key});
  @override
  Widget build(BuildContext context) => const Center(
        child: SizedBox(
          width: 28,
          height: 28,
          child: CircularProgressIndicator(strokeWidth: 2.4, color: NoktaTheme.orange),
        ),
      );
}

class Problem extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const Problem({super.key, required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) => Blank(
        icon: Icons.wifi_off_rounded,
        title: 'Şu an ulaşamadım',
        body: message,
        actionLabel: 'Tekrar dene',
        onAction: onRetry,
      );
}

/// A row on a settings-style list.
class Line extends StatelessWidget {
  final IconData icon;
  final String label;
  final String? value;
  final VoidCallback? onTap;
  final Color? tint;

  const Line({super.key, required this.icon, required this.label, this.value, this.onTap, this.tint});

  @override
  Widget build(BuildContext context) {
    final c = tint ?? NoktaTheme.text;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 17),
        child: Row(
          children: [
            Icon(icon, size: 21, color: tint ?? NoktaTheme.text2),
            const SizedBox(width: 14),
            Expanded(
              child: Text(label,
                  style: TextStyle(color: c, fontSize: 15.5, fontWeight: FontWeight.w600)),
            ),
            if (value != null)
              Text(value!,
                  style: const TextStyle(color: NoktaTheme.text3, fontSize: 14.5)),
            if (onTap != null) const SizedBox(width: 6),
            if (onTap != null)
              const Icon(Icons.chevron_right_rounded, size: 22, color: NoktaTheme.text3),
          ],
        ),
      ),
    );
  }
}

/// A card-shaped container for a group of [Line]s.
class Panel extends StatelessWidget {
  final List<Widget> children;
  final String? title;
  const Panel({super.key, required this.children, this.title});

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var i = 0; i < children.length; i++) {
      if (i > 0) {
        rows.add(const Padding(
          padding: EdgeInsets.only(left: 53),
          child: Divider(height: 1, thickness: 1, color: NoktaTheme.line),
        ));
      }
      rows.add(children[i]);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title != null)
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 10),
            child: Text(title!.toUpperCase(),
                style: const TextStyle(
                    color: NoktaTheme.text3,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.1)),
          ),
        Container(
          decoration: BoxDecoration(
            color: NoktaTheme.card,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: NoktaTheme.line),
          ),
          child: Column(children: rows),
        ),
      ],
    );
  }
}

/// "14 Eylül, 21:30" from the API's "2026-09-14 21:30:00".
///
/// Parsed rather than formatted with intl's locale data, because the server
/// sends a fixed shape and the month names are the only thing that needs
/// translating. A string this app cannot parse is shown as it arrived instead
/// of being dropped.
String trWhen(String? raw) {
  if (raw == null || raw.isEmpty) return '';
  final t = DateTime.tryParse(raw.replaceFirst(' ', 'T'));
  if (t == null) return raw;
  const months = [
    'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
    'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
  ];
  final hh = t.hour.toString().padLeft(2, '0');
  final mm = t.minute.toString().padLeft(2, '0');
  return '${t.day} ${months[t.month - 1]}, $hh:$mm';
}
