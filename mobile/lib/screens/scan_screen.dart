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

  @override
  void dispose() {
    /* dispose() on the controller is async and State.dispose() is not; the
       camera is released when it completes and nothing here waits for it. */
    unawaited(_controller.dispose());
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_done) return;
    for (final b in capture.barcodes) {
      final qr = PairQr.parse(b.rawValue ?? '');
      if (qr == null) continue;
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
          left: 24, right: 24, bottom: 42,
          child: Text(
            'Kasadaki "Telefon bagla" ekranindaki kareyi bu cercevenin icine alin.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white, fontSize: 14.5, height: 1.45),
          ),
        ),
      ]),
    );
  }

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
