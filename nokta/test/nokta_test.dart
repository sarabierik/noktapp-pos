import 'package:flutter_test/flutter_test.dart';
import 'package:nokta/models/models.dart';
import 'package:nokta/theme.dart';

/// A real test file, and it is here for two reasons.
///
/// The second one is the sneaky one: `flutter create .` writes its own
/// test/widget_test.dart when that folder has nothing in it, and the file it
/// writes pumps `const MyApp()` - a class this project does not have. Every
/// `flutter analyze` after a project regeneration then failed on generated
/// code nobody wrote. A test folder that is already occupied is never touched.
///
/// The first reason is that these are the two places in the app where a guest
/// would see a wrong NUMBER rather than a wrong layout, and a wrong number on
/// a loyalty card is the thing they will argue with a cashier about.
void main() {
  group('kart ilerlemesi', () {
    LoyaltyCard card({required int target, required int progress}) =>
        LoyaltyCard.fromJson({
          'tenant_id': 19, 'restaurant': 'Deneme', 'program_id': 3,
          'title': '4 pizza al 1 bizden', 'reward_text': '1 pizza bizden',
          'target_count': target, 'progress_count': progress,
          'remaining': target - progress, 'rewards_available': 0,
          'rewards_used': 0, 'is_active': 1,
        });

    test('bos kart sifirdan baslar', () {
      expect(card(target: 4, progress: 0).fraction, 0.0);
    });

    test('yarisi dolu kart 0.5', () {
      expect(card(target: 4, progress: 2).fraction, 0.5);
    });

    test('hedefi asan pul barin disina tasmaz', () {
      /* The till can write a sixth stamp on a five-stamp card before the
         reward is claimed. The bar has to stay a bar. */
      expect(card(target: 5, progress: 7).fraction, 1.0);
    });

    test('hedefi sifir olan kampanya sifira bolmez', () {
      /* target is floored to 1 on the way in, so this is 0/1 rather than a
         NaN that paints nothing and looks like a broken card. */
      final c = card(target: 0, progress: 0);
      expect(c.target, 1);
      expect(c.fraction, 0.0);
      expect(c.fraction.isNaN, isFalse);
    });

    test('eksi ilerleme negatif bar cizdirmez', () {
      expect(card(target: 4, progress: -2).fraction, 0.0);
    });
  });

  group('tek kullanimlik kod', () {
    test('sunucunun verdigi saniye bu telefonun saatinden sayilir', () {
      final c = OneTimeCode.fromJson({'token': 'abc', 'expires_in': 300});
      expect(c.left.inSeconds, greaterThan(290));
      expect(c.left.inSeconds, lessThanOrEqualTo(300));
    });

    test('suresi gecmis kod eksi degil sifir gosterir', () {
      final c = OneTimeCode(token: 'abc',
          expiresAt: DateTime.now().subtract(const Duration(minutes: 5)));
      expect(c.left, Duration.zero);
    });

    test('sunucu sure vermezse bes dakika varsayilir', () {
      final c = OneTimeCode.fromJson({'token': 'abc'});
      expect(c.left.inSeconds, greaterThan(290));
    });
  });

  group('fiyat yazimi', () {
    test('binlik ayraci nokta, kurus virgul', () {
      expect(NoktaTheme.tl(1250), '1.250,00 ₺');
      expect(NoktaTheme.tl(99.5), '99,50 ₺');
      expect(NoktaTheme.tl(0), '0,00 ₺');
      expect(NoktaTheme.tl(1234567.89), '1.234.567,89 ₺');
    });
  });

  group('misafir adi', () {
    test('soyadi yoksa tek harf, iki isim varsa iki harf', () {
      expect(Guest.fromJson({'first_name': 'Mehdi'}).initials, 'M');
      expect(Guest.fromJson({'first_name': 'Mehdi', 'last_name': 'Sarabi'}).initials, 'MS');
      expect(Guest.fromJson({}).initials, '?');
    });

    test('soyadi bos gelirse ad tek basina gosterilir', () {
      expect(Guest.fromJson({'first_name': 'Mehdi', 'last_name': ''}).fullName, 'Mehdi');
    });
  });
}
