import 'package:flutter/material.dart';
import 'services/api.dart';
import 'screens/pair_screen.dart';
import 'screens/tables_screen.dart';
import 'theme.dart';

/// NOKTApp Garson.
///
/// Deliberately a small app: take the order, print the bill, mail the bill.
/// Everything else - payments, reports, the cash drawer - stays at the till
/// where the money is, which is also what the restaurant's accountant expects.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  /*
   * runApp FIRST, and load the saved session inside the app rather than in
   * front of it.
   *
   * It used to `await Api.instance.load()` here, before a single frame was
   * drawn. The Android launch plate handed over to Flutter, Flutter had
   * nothing to draw yet, and what the waiter got was a white rectangle for as
   * long as SharedPreferences took to answer - which on a cheap handset after
   * a cold start is not a flicker, it is a second or two of an app that looks
   * broken every time it is opened.
   */
  runApp(const NoktAppGarson());
}

class NoktAppGarson extends StatelessWidget {
  const NoktAppGarson({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NOKTApp Garson',
      debugShowCheckedModeBanner: false,
      theme: NokTheme.theme,
      home: const _Acilis(),
    );
  }
}

/// Loads the saved session, showing the brand plate while it does.
class _Acilis extends StatefulWidget {
  const _Acilis();
  @override
  State<_Acilis> createState() => _AcilisState();
}

class _AcilisState extends State<_Acilis> {
  bool hazir = false;
  bool eslesti = false;

  @override
  void initState() {
    super.initState();
    _yukle();
  }

  Future<void> _yukle() async {
    try {
      await Api.instance.load();
    } catch (_) {
      /* a corrupt preference file must not stop the app opening - the waiter
         can always pair again, but only if a screen appears */
    }
    if (!mounted) return;
    setState(() {
      eslesti = Api.instance.token != null;
      hazir = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!hazir) return const AcilisEkrani();
    return eslesti ? const TablesScreen() : const PairScreen();
  }
}

/// The brand plate - the same orange the Android launch screen uses, so the
/// hand-over from one to the other is invisible instead of a white flash.
class AcilisEkrani extends StatelessWidget {
  const AcilisEkrani({super.key, this.mesaj});

  /// "Masalar yukleniyor", "Kasa araniyor" - said out loud, because a waiter
  /// standing in front of a spinner with no words assumes it has hung.
  final String? mesaj;

  @override
  Widget build(BuildContext context) {
    /*
     * WHITE, WITH THE MARK - not a wall of orange.
     *
     * A full orange screen for a second reads as an interruption; the eye has
     * to adjust twice, once into it and once out of it into the white app.
     * The plate is the app's own surface with the mark on it, so the opening
     * is one continuous thing, and the Android launch screen was changed to
     * match - there is no flash between them at all any more.
     */
    return Scaffold(
      backgroundColor: Colors.white,
      body: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 84, height: 84,
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                  begin: Alignment.topLeft, end: Alignment.bottomRight,
                  colors: [NokTheme.orange, NokTheme.orangeDark]),
              borderRadius: BorderRadius.circular(22),
            ),
            child: const Center(
              child: Text('NG',
                  style: TextStyle(
                      color: Colors.white,
                      fontSize: 32,
                      fontWeight: FontWeight.w800,
                      letterSpacing: .5)),
            ),
          ),
          const SizedBox(height: 18),
          const Text('NOKTApp Garson',
              style: TextStyle(
                  color: NokTheme.ink, fontSize: 17, fontWeight: FontWeight.w700)),
          const SizedBox(height: 22),
          /* A bar, not a spinner: it sits still on the page instead of
             drawing the eye round in circles, and it is 2 pixels of movement
             rather than a wheel that makes a one second wait feel like five. */
          SizedBox(
            width: 132,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(2),
              child: const LinearProgressIndicator(
                minHeight: 3,
                backgroundColor: Color(0xFFEFEFF1),
                color: NokTheme.orange,
              ),
            ),
          ),
          if (mesaj != null) ...[
            const SizedBox(height: 14),
            Text(mesaj!, style: const TextStyle(color: NokTheme.ink3, fontSize: 13)),
          ],
        ]),
      ),
    );
  }
}
