import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:nokta/main.dart';

/// Does the app start at all.
///
/// This file's NAME matters as much as its contents: `flutter create .` writes
/// its own test/widget_test.dart whenever that exact path is missing, and the
/// file it writes pumps `const MyApp()` - a class this project has never had.
/// Every regeneration therefore broke `flutter analyze` on generated code. The
/// path being occupied is what stops that.
///
/// What it actually proves is worth having on its own: the whole tree builds,
/// the stored-token check runs, and a phone with no session lands on the login
/// screen rather than a black rectangle. Nothing here touches the network -
/// the login screen makes no call until somebody presses the button.
void main() {
  testWidgets('jetonu olmayan telefon giris ekraninda acilir', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});

    await tester.pumpWidget(const NoktaApp());

    /* First frame: the splash, while the stored token is being read. */
    expect(find.text('NOKTA'), findsOneWidget);

    await tester.pumpAndSettle();

    expect(find.text('Hoş geldiniz'), findsOneWidget);
    expect(find.text('Giriş yap'), findsOneWidget);
    /* and it offers the other door rather than stranding somebody new */
    expect(find.text('Hesabım yok, kayıt olayım'), findsOneWidget);
  });
}
