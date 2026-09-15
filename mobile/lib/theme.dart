import 'package:flutter/material.dart';

/// The same visual language as the till: light surfaces, one orange accent,
/// hairline borders, no shadows, large touch targets for a moving waiter.
class NokTheme {
  /// One colour per category card, repeating after eight. Position is what a
  /// waiter actually learns on a handheld - the colour is the shortcut to it.
  static const List<Color> categoryColours = [
    Color(0xFFFF7A1A), Color(0xFF8A5CF6), Color(0xFF0EA5E9), Color(0xFFF43F5E),
    Color(0xFFF59E0B), Color(0xFF14B8A6), Color(0xFF6366F1), Color(0xFFE11D48),
  ];
  static Color categoryColour(int i) => categoryColours[i % categoryColours.length];

  static const orange = Color(0xFFFF7A1A);
  static const orangeDark = Color(0xFFEA580C);
  static const ink = Color(0xFF18181B);
  static const ink2 = Color(0xFF52525B);
  static const ink3 = Color(0xFF8E8E96);
  static const line = Color(0xFFE4E4E7);
  static const bg = Color(0xFFF6F6F7);
  /// Success is graphite. The product carries exactly one accent colour.
  static const ok = Color(0xFF1F1F24);

  static ThemeData get theme => ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: bg,
        colorScheme: ColorScheme.fromSeed(
          seedColor: orange,
          primary: orange,
          surface: Colors.white,
          brightness: Brightness.light,
        ),
        fontFamily: 'Roboto',
        appBarTheme: const AppBarTheme(
          backgroundColor: Colors.white,
          foregroundColor: ink,
          elevation: 0,
          scrolledUnderElevation: 0,
          surfaceTintColor: Colors.transparent,
          shape: Border(bottom: BorderSide(color: line)),
          titleTextStyle: TextStyle(color: ink, fontSize: 17, fontWeight: FontWeight.w600),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0xFFD4D4D8)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0xFFD4D4D8)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: orange, width: 1.6),
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: orange,
            minimumSize: const Size(0, 52),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            foregroundColor: ink,
            minimumSize: const Size(0, 52),
            side: const BorderSide(color: Color(0xFFD4D4D8)),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
        ),
      );

  /// A quantity the way a Turkish waiter says it: 1 - 1,5 - 2. Never "1.5",
  /// which is a foreign number, and never "1,50", which is a price.
  ///
  /// Portions come in halves and nothing finer - yarim porsiyon is a real
  /// thing a kitchen plates, a third is not - so anything else that arrives
  /// (a 0.33 typed at the till, an old row) is snapped here exactly the way
  /// the server's halves() snaps it. Drawing a quantity the kitchen will not
  /// be asked to cook is how a waiter ends up arguing with a printed slip.
  static String qty(num v) {
    final snapped = (v * 2).round() / 2;
    if (snapped == snapped.roundToDouble()) return snapped.toStringAsFixed(0);
    return snapped.toStringAsFixed(1).replaceAll('.', ',');
  }

  static String tl(num v) {
    final s = v.toStringAsFixed(2).replaceAll('.', ',');
    final parts = s.split(',');
    final whole = parts[0].replaceAllMapped(
        RegExp(r'(\d)(?=(\d{3})+$)'), (m) => '${m[1]}.');
    return '$whole,${parts[1]} ₺';
  }
}
