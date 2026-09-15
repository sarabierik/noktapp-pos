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
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Api.instance.load();
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
      home: Api.instance.token == null ? const PairScreen() : const TablesScreen(),
    );
  }
}
