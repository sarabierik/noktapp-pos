import 'package:flutter/material.dart';

/// NOKTA is a wallet, and a wallet is dark.
///
/// The till and the panel are light surfaces because somebody stares at them
/// for nine hours under kitchen lighting. This is the opposite job: it is held
/// up at a counter for four seconds, usually in the evening, and the one thing
/// on screen that matters has to be the card. So the background gets out of the
/// way and the cards are the only lit objects on it.
///
/// One accent colour, the product's orange. Nothing here is green - a finished
/// card is orange and a stamp that has not been earned yet is simply unlit.
/// Two colours competing for "this is the good news" is how a guest ends up
/// reading the wrong number.
class NoktaTheme {
  static const orange     = Color(0xFFFF7A1A);
  static const orangeDark = Color(0xFFEA580C);

  static const bg      = Color(0xFF0B0B0F);   // the page
  static const card    = Color(0xFF16161C);   // a card on it
  static const raised  = Color(0xFF1E1E26);   // something on the card
  static const line    = Color(0xFF27272E);   // hairline

  static const text    = Color(0xFFFAFAFA);
  static const text2   = Color(0xFFA1A1AA);
  static const text3   = Color(0xFF71717A);

  /// The fill of a stamp that has not been earned yet. Deliberately close to
  /// the card colour: an empty slot should read as "not yet", not as an error.
  static const empty   = Color(0xFF2A2A33);

  static ThemeData get theme => ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        scaffoldBackgroundColor: bg,
        canvasColor: bg,
        colorScheme: const ColorScheme.dark(
          primary: orange,
          onPrimary: Colors.white,
          secondary: orange,
          surface: card,
          onSurface: text,
          error: Color(0xFFF87171),
        ),
        fontFamily: 'Roboto',
        appBarTheme: const AppBarTheme(
          backgroundColor: bg,
          foregroundColor: text,
          elevation: 0,
          scrolledUnderElevation: 0,
          surfaceTintColor: Colors.transparent,
          centerTitle: false,
          titleTextStyle: TextStyle(
              color: text, fontSize: 20, fontWeight: FontWeight.w700, letterSpacing: -0.2),
        ),
        dividerColor: line,
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: raised,
          hintStyle: const TextStyle(color: text3),
          labelStyle: const TextStyle(color: text2),
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: line),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: line),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: orange, width: 1.6),
          ),
          errorBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFFF87171)),
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: orange,
            foregroundColor: Colors.white,
            disabledBackgroundColor: empty,
            disabledForegroundColor: text3,
            minimumSize: const Size(0, 54),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ),
        textButtonTheme: TextButtonThemeData(
          style: TextButton.styleFrom(
            foregroundColor: orange,
            textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            foregroundColor: text,
            side: const BorderSide(color: line),
            minimumSize: const Size(0, 54),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
        ),
        snackBarTheme: const SnackBarThemeData(
          backgroundColor: raised,
          contentTextStyle: TextStyle(color: text),
          behavior: SnackBarBehavior.floating,
        ),
        bottomNavigationBarTheme: const BottomNavigationBarThemeData(
          backgroundColor: Color(0xFF101016),
          selectedItemColor: orange,
          unselectedItemColor: text3,
          type: BottomNavigationBarType.fixed,
          showUnselectedLabels: true,
          elevation: 0,
        ),
      );

  /// Prices the way they are written in Turkey: 1.250,00 ₺
  static String tl(num v) {
    final s = v.toStringAsFixed(2).replaceAll('.', ',');
    final parts = s.split(',');
    final whole = parts[0].replaceAllMapped(
        RegExp(r'(\d)(?=(\d{3})+$)'), (m) => '${m[1]}.');
    return '$whole,${parts[1]} ₺';
  }
}
