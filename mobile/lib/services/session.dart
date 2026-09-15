import '../models/models.dart';

/// WHAT THIS HANDSET IS ALLOWED TO DO.
///
/// The bootstrap answer carries the permission list the till resolved for
/// whoever paired this device, and every screen draws its buttons from it. The
/// server refuses on exactly the same list, so a greyed-out button and a
/// refused request can never disagree - which is the whole point. A button the
/// waiter can press and that then fails is worse than no button: it teaches
/// them the handset is unreliable rather than that they lack the key.
class Session {
  static final Session instance = Session._();
  Session._();

  List<String> perms = const [];
  List<Station> stations = const [];
  String userName = '';
  int userId = 0;
  String role = '';

  void adopt(Map<String, dynamic> bootstrap) {
    perms = ((bootstrap['perms'] ?? []) as List).map((e) => '$e').toList(growable: false);
    stations = ((bootstrap['stations'] ?? []) as List)
        .map((s) => Station.fromJson(s as Map<String, dynamic>))
        .toList(growable: false);
    final me = (bootstrap['me'] ?? {}) as Map<String, dynamic>;
    userName = '${me['name'] ?? ''}';
    userId = (me['id'] ?? 0) as int;
    role = '${me['role'] ?? ''}';
  }

  bool can(String perm) => perms.contains(perm);

  /* The four the handset actually offers, named once so a screen never spells
     a permission key by hand and quietly mistypes it. */
  bool get canOrder => can('order.create');
  bool get canCancelLine => can('order.item.cancel');
  bool get canTransfer => can('order.transfer');
  bool get canDiscount => can('order.discount');
  bool get canTakePayment => can('payment.take');
}
