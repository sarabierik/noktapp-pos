import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../services/api.dart';
import '../theme.dart';

/// The camera half of "Telefon bagla".
///
/// It pops with a [PairQr] and does nothing else: no network call, no token,
/// no navigation into the app. Pairing stays in one place (PairScreen), so
/// there is exactly one piece of code that can leave a phone half connected.
///
/// Two things this screen refuses to do:
///   * complain about the wrong barcode. A restaurant is full of QR symbols -
///     table cards, wifi cards, the ketchup bottle - and an error toast for
///     each one would bury the till's symbol in noise. Anything that is not
///     ours is simply not a match yet.
///   * fire twice. The detection stream delivers the same symbol thirty times
///     a second while the phone is held still; without the latch the first
///     frame pops the screen and the next twenty-nine pop whatever is under
///     it.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});
  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
  );
  bool _done = false;
  bool _torch = false;

  /*
   * WHAT THE CAMERA IS ACTUALLY SEEING.
   *
   * This screen used to be silent by design: anything that was not our symbol
   * "is simply not a match yet". That reads well and it cost a day. When the
   * till's symbol ALSO fails to match - a phone whose barcode engine never
   * starts, a till on an older build emitting a different payload - the screen
   * behaves in exactly the same way as when it is pointed at a ketchup bottle:
   * nothing, for ever. The owner's report is "the app cannot read the QR" and
   * there is not one fact in it to work from.
   *
   * So the screen now says what it sees. A foreign symbol is named. A camera
   * that has not decoded anything at all after six seconds says THAT, which is
   * a different fault with a different fix, and the two are no longer
   * indistinguishable from the outside.
   */
  int _frames = 0;            // symbols decoded, ours or not
  String? _foreign;           // the last symbol that was not ours
  bool _slow = false;         // six seconds, nothing decoded
  Timer? _watchdog;

  @override
  void initState() {
    super.initState();
    _watchdog = Timer(const Duration(seconds: 6), () {
      if (mounted && _frames == 0 && !_done) setState(() => _slow = true);
    });
  }

  @override
  void dispose() {
    /* dispose() on the controller is async and State.dispose() is not; the
       camera is released when it completes and nothing here waits for it. */
    _watchdog?.cancel();
    unawaited(_controller.dispose());
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_done) return;
    for (final b in capture.barcodes) {
      final raw = b.rawValue ?? '';
      if (raw.isEmpty) continue;
      final qr = PairQr.parse(raw);
      if (qr == null) {
        /* Not ours. Name it once - quietly, at the bottom - instead of
           pretending the camera saw nothing. */
        if (mounted) {
          setState(() {
            _frames++;
            _slow = false;
            _foreign = raw.length > 60 ? '${raw.substring(0, 60)}...' : raw;
          });
        }
        continue;
      }
      _done = true;
      Navigator.of(context).pop(qr);
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('Karekodu okut'),
        actions: [
          IconButton(
            tooltip: 'Isik',
            icon: Icon(_torch ? Icons.flashlight_on : Icons.flashlight_off),
            onPressed: () async {
              await _controller.toggleTorch();
              if (mounted) setState(() => _torch = !_torch);
            },
          ),
        ],
      ),
      body: Stack(children: [
        MobileScanner(controller: _controller, onDetect: _onDetect, errorBuilder: _cameraProblem),
        // The frame is the instruction: people aim at the square.
        IgnorePointer(
          child: Center(
            child: Container(
              width: 250,
              height: 250,
              decoration: BoxDecoration(
                border: Border.all(color: NokTheme.orange, width: 3),
                borderRadius: BorderRadius.circular(18),
              ),
            ),
          ),
        ),
        Positioned(
          left: 20, right: 20, bottom: 32,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Text(
              'Kasadaki "Telefon bagla" ekranindaki kareyi bu cercevenin icine alin.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.white, fontSize: 14.5, height: 1.45),
            ),
            if (_foreign != null) _not(
              'Bu karekod NOKTApp\'a ait degil:',
              _foreign!,
              'Kasada Ayarlar > Cihazlar > Telefon bagla ekranindaki kareyi okutun.',
            ),
            if (_slow) _not(
              'Kamera calisiyor ama hicbir karekod cozulemiyor.',
              null,
              'Isigi acin ve 15-20 cm yaklasin. Yine olmazsa geri donup alti haneli '
              'kodu elle yazin - bu telefonun karekod motoru calismiyor olabilir.',
            ),
          ]),
        ),
      ]),
    );
  }

  /// The bottom card that turns "nothing happens" into a sentence.
  Widget _not(String baslik, String? kod, String ne) => Container(
        margin: const EdgeInsets.only(top: 14),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.72),
          border: Border.all(color: NokTheme.orange, width: 1.5),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(baslik,
              textAlign: TextAlign.center,
              style: const TextStyle(
                  color: Colors.white, fontWeight: FontWeight.w700, fontSize: 14)),
          if (kod != null) ...[
            const SizedBox(height: 6),
            Text(kod,
                textAlign: TextAlign.center,
                style: const TextStyle(
                    color: Colors.white70, fontSize: 12, fontFamily: 'monospace')),
          ],
          const SizedBox(height: 8),
          Text(ne,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white70, fontSize: 12.5, height: 1.4)),
        ]),
      );

  /// No camera, or permission refused. Both end the same way - go back and
  /// type the six digits - so they get one screen and one sentence.
  Widget _cameraProblem(BuildContext context, MobileScannerException error) {
    final denied = error.errorCode == MobileScannerErrorCode.permissionDenied;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.no_photography_outlined, color: Colors.white54, size: 48),
          const SizedBox(height: 16),
          Text(
            denied
                ? 'Kamera izni verilmedi. Telefon ayarlarindan NOKTApp Garson icin kamerayi acin, '
                    'ya da geri donup alti haneli kodu elle yazin.'
                : 'Bu telefonun kamerasi kullanilamiyor. Geri donup alti haneli kodu elle yazabilirsiniz.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white, height: 1.5),
          ),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Kodu elle yaz'),
          ),
        ]),
      ),
    );
  }
}
