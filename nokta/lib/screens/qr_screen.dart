import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../theme.dart';
import '../widgets/bits.dart';

/// Karekod — the screen held up at the counter.
///
/// Three decisions worth knowing about:
///
/// 1. The code shown is a ONE-TIME code, not the permanent one on a printed
///    card. It dies five minutes after it is minted and the first till that
///    spends it burns it centrally, so a photograph of this screen is worth
///    nothing tomorrow. The permanent card code is still reachable, one tap
///    down, for the case where the code will not scan.
///
/// 2. The code panel is WHITE, not a dark card. A QR drawn light-on-dark looks
///    better in a dark app and scans worse, and the counter's reader wins that
///    argument. (Raising the phone's screen brightness while this screen is open
///    would help further on a dimmed evening phone; that needs a platform
///    plugin and is not done yet - see BASLA.md.)
///
/// 3. The countdown is a real countdown, and at zero the code is replaced rather
///    than left on screen looking valid. A cashier scanning a dead code and
///    being told the guest has no account is worse than a guest pressing
///    refresh.
class QrScreen extends StatefulWidget {
  const QrScreen({super.key});

  @override
  State<QrScreen> createState() => _QrScreenState();
}

class _QrScreenState extends State<QrScreen> {
  OneTimeCode? _code;
  String? _error;
  bool _busy = false;
  bool _showPermanent = false;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _mint();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      final c = _code;
      if (c != null && c.left == Duration.zero && !_busy) {
        _mint();
      } else {
        setState(() {});
      }
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _mint() async {
    setState(() { _busy = true; _error = null; });
    try {
      final c = await Api.instance.mintCode();
      if (!mounted) return;
      setState(() { _code = c; _error = null; });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _mmss(Duration d) {
    final m = d.inMinutes;
    final s = d.inSeconds % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final code = _code;
    if (_error != null && code == null) {
      return Problem(message: _error!, onRetry: _mint);
    }

    final permanent = code?.cardCode ?? Api.instance.me?.cardCode;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 32),
      child: Column(
        children: [
          const Text('Kasada bu kodu okutun',
              style: TextStyle(
                  color: NoktaTheme.text, fontSize: 19, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          const Text('Kod 5 dakika geçerli ve tek kullanımlık.',
              textAlign: TextAlign.center,
              style: TextStyle(color: NoktaTheme.text2, fontSize: 13.5)),
          const SizedBox(height: 24),

          /* White, square, quiet zone included. A QR on a dark card looks
             better and scans worse; the counter's reader wins this argument. */
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(20),
            ),
            child: code == null
                ? const SizedBox(width: 240, height: 240, child: Loading())
                : QrImageView(
                    data: code.token,
                    version: QrVersions.auto,
                    size: 240,
                    backgroundColor: Colors.white,
                    gapless: true,
                  ),
          ),
          const SizedBox(height: 20),

          if (code != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              decoration: BoxDecoration(
                color: NoktaTheme.card,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: NoktaTheme.line),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.timer_outlined,
                      size: 17,
                      color: code.left.inSeconds < 30 ? NoktaTheme.orange : NoktaTheme.text3),
                  const SizedBox(width: 8),
                  Text(_mmss(code.left),
                      style: TextStyle(
                          color: code.left.inSeconds < 30 ? NoktaTheme.orange : NoktaTheme.text2,
                          fontSize: 14.5,
                          fontWeight: FontWeight.w700,
                          fontFeatures: const [FontFeature.tabularFigures()])),
                ],
              ),
            ),

          const SizedBox(height: 18),
          SizedBox(
            width: 220,
            child: OutlinedButton.icon(
              onPressed: _busy ? null : _mint,
              icon: const Icon(Icons.refresh_rounded, size: 19),
              label: const Text('Yeni kod'),
            ),
          ),

          const SizedBox(height: 26),
          const Divider(color: NoktaTheme.line, height: 1),
          const SizedBox(height: 18),

          if (permanent == null)
            const Text('Kalıcı kart kodunuz yok.',
                style: TextStyle(color: NoktaTheme.text3, fontSize: 13))
          else if (!_showPermanent)
            TextButton(
              onPressed: () => setState(() => _showPermanent = true),
              child: const Text('Karekod okunmuyor mu? Kart kodumu göster'),
            )
          else
            Column(
              children: [
                const Text('KALICI KART KODU',
                    style: TextStyle(
                        color: NoktaTheme.text3,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.1)),
                const SizedBox(height: 10),
                SelectableText(permanent,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                        color: NoktaTheme.text,
                        fontSize: 15,
                        fontFamily: 'monospace',
                        letterSpacing: 0.5)),
                const SizedBox(height: 10),
                TextButton.icon(
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: permanent));
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Kart kodu kopyalandı')));
                  },
                  icon: const Icon(Icons.copy_rounded, size: 18),
                  label: const Text('Kopyala'),
                ),
                const SizedBox(height: 6),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 12),
                  child: Text(
                      'Bu kod kalıcıdır — kasaya okutabilir ama kimseyle paylaşmayın.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: NoktaTheme.text3, fontSize: 12, height: 1.4)),
                ),
              ],
            ),
        ],
      ),
    );
  }
}
