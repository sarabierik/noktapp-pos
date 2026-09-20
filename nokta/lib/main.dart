import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'services/api.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'theme.dart';

/// NOKTA — the guest side of NOKTApp.
///
/// One person, one account, every NOKTApp restaurant. A stamp written at a
/// counter in Alanya and a stamp written in Antalya land on the same wallet,
/// because the guest registry is shared and the campaign definitions are
/// mirrored up from each till.
///
/// The app is a reader. It never writes a stamp and never spends a reward -
/// only a till may do that, at the counter, with the guest present. What it
/// does is show what is there and hand over a code the cashier can scan.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: Color(0xFF101016),
    systemNavigationBarIconBrightness: Brightness.light,
  ));
  runApp(const NoktaApp());
}

class NoktaApp extends StatefulWidget {
  const NoktaApp({super.key});

  @override
  State<NoktaApp> createState() => _NoktaAppState();
}

enum _Stage { starting, signedOut, signedIn }

class _NoktaAppState extends State<NoktaApp> {
  _Stage _stage = _Stage.starting;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    await Api.instance.load();
    if (!mounted) return;
    setState(() => _stage = Api.instance.signedIn ? _Stage.signedIn : _Stage.signedOut);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NOKTA',
      debugShowCheckedModeBanner: false,
      theme: NoktaTheme.theme,
      home: switch (_stage) {
        _Stage.starting => const _Splash(),
        _Stage.signedOut => LoginScreen(
            onSignedIn: () => setState(() => _stage = _Stage.signedIn),
          ),
        _Stage.signedIn => HomeScreen(
            /* A signed-out session must not leave a screen behind that will
               immediately 401. Rebuilding from the root is the only way to be
               sure every tab's state goes with it. */
            onSignedOut: () => setState(() => _stage = _Stage.signedOut),
          ),
      },
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Text('NOKTA',
            style: TextStyle(
                color: NoktaTheme.orange,
                fontSize: 30,
                fontWeight: FontWeight.w900,
                letterSpacing: 6)),
      ),
    );
  }
}
