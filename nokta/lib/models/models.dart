/// The shapes the guest API sends. One file, because there are five of them and
/// they are all small.
///
/// Every `fromJson` here is written to survive a field that is missing or null.
/// The API is ours and it is consistent, but a phone in somebody's pocket
/// outlives the version of the server it was written against - a guest who does
/// not update for a year still has to be able to open the app and see their
/// cards. A screen that throws because a field arrived null is a screen that is
/// blank for a reason the guest cannot act on.
library;

int _i(dynamic v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  return int.tryParse('${v ?? ''}') ?? 0;
}

double? _d(dynamic v) {
  if (v == null) return null;
  if (v is num) return v.toDouble();
  return double.tryParse('$v');
}

String _s(dynamic v) => v == null ? '' : '$v';
String? _sn(dynamic v) {
  final s = v == null ? '' : '$v';
  return s.isEmpty ? null : s;
}

class Guest {
  final int id;
  final String firstName;
  final String? lastName;
  final String phone;
  final String? email;
  final String? birthDate;
  final String? cardCode;
  final String? memberSince;

  Guest({
    required this.id,
    required this.firstName,
    this.lastName,
    required this.phone,
    this.email,
    this.birthDate,
    this.cardCode,
    this.memberSince,
  });

  String get fullName {
    final l = lastName;
    return (l == null || l.isEmpty) ? firstName : '$firstName $l';
  }

  /// The two letters on the avatar. A single name gives one letter rather than
  /// two halves of the same word.
  String get initials {
    final a = firstName.trim();
    final b = (lastName ?? '').trim();
    if (a.isEmpty && b.isEmpty) return '?';
    if (b.isEmpty) return a.substring(0, 1).toUpperCase();
    return (a.substring(0, 1) + b.substring(0, 1)).toUpperCase();
  }

  factory Guest.fromJson(Map<String, dynamic> j) => Guest(
        id: _i(j['id']),
        firstName: _s(j['first_name']),
        lastName: _sn(j['last_name']),
        phone: _s(j['phone']),
        email: _sn(j['email']),
        birthDate: _sn(j['birth_date']),
        cardCode: _sn(j['qr_uid']),
        memberSince: _sn(j['member_since']),
      );
}

class LoyaltyCard {
  final int tenantId;
  final String restaurant;
  final String? city;
  final int programId;
  final String title;
  final String rewardText;
  final String? productName;
  final double? productPrice;
  final int target;
  final int progress;
  final int remaining;
  final int rewardsAvailable;
  final int rewardsUsed;
  final bool active;
  final String? updatedAt;

  LoyaltyCard({
    required this.tenantId,
    required this.restaurant,
    this.city,
    required this.programId,
    required this.title,
    required this.rewardText,
    this.productName,
    this.productPrice,
    required this.target,
    required this.progress,
    required this.remaining,
    required this.rewardsAvailable,
    required this.rewardsUsed,
    required this.active,
    this.updatedAt,
  });

  bool get hasReward => rewardsAvailable > 0;

  /// 0..1, for the bar. Never above 1 and never NaN: a target of zero would
  /// otherwise divide by zero and paint nothing at all.
  double get fraction {
    if (target <= 0) return 0;
    final f = progress / target;
    return f < 0 ? 0 : (f > 1 ? 1 : f);
  }

  String get key => '$tenantId:$programId';

  factory LoyaltyCard.fromJson(Map<String, dynamic> j) {
    final target = _i(j['target_count']);
    return LoyaltyCard(
      tenantId: _i(j['tenant_id']),
      restaurant: _s(j['restaurant']).isEmpty ? 'NOKTApp restoranı' : _s(j['restaurant']),
      city: _sn(j['city']),
      programId: _i(j['program_id']),
      title: _s(j['title']),
      rewardText: _s(j['reward_text']),
      productName: _sn(j['product_name']),
      productPrice: _d(j['product_price']),
      target: target < 1 ? 1 : target,
      progress: _i(j['progress_count']),
      remaining: _i(j['remaining']),
      rewardsAvailable: _i(j['rewards_available']),
      rewardsUsed: _i(j['rewards_used']),
      active: _i(j['is_active']) == 1,
      updatedAt: _sn(j['updated_at']),
    );
  }
}

class CardGroup {
  final int tenantId;
  final String restaurant;
  final String? city;
  final List<LoyaltyCard> cards;

  CardGroup({required this.tenantId, required this.restaurant, this.city, required this.cards});

  factory CardGroup.fromJson(Map<String, dynamic> j) => CardGroup(
        tenantId: _i(j['tenant_id']),
        restaurant: _s(j['restaurant']).isEmpty ? 'NOKTApp restoranı' : _s(j['restaurant']),
        city: _sn(j['city']),
        cards: ((j['cards'] as List?) ?? const [])
            .map((e) => LoyaltyCard.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(),
      );
}

class Movement {
  final int tenantId;
  final String restaurant;
  final int programId;
  final String? programTitle;
  final String kind;      // stamp | reward | adjust
  final int qty;
  final String? productName;
  final String? happenedAt;

  Movement({
    required this.tenantId,
    required this.restaurant,
    required this.programId,
    this.programTitle,
    required this.kind,
    required this.qty,
    this.productName,
    this.happenedAt,
  });

  bool get isReward => kind == 'reward';

  factory Movement.fromJson(Map<String, dynamic> j) => Movement(
        tenantId: _i(j['tenant_id']),
        restaurant: _s(j['restaurant']).isEmpty ? 'NOKTApp restoranı' : _s(j['restaurant']),
        programId: _i(j['program_id']),
        programTitle: _sn(j['program_title']),
        kind: _s(j['kind']).isEmpty ? 'stamp' : _s(j['kind']),
        qty: _i(j['qty']),
        productName: _sn(j['product_name']),
        happenedAt: _sn(j['happened_at']),
      );
}

class Campaign {
  final int programId;
  final String title;
  final int target;
  final String rewardText;
  final String? productName;
  final bool alreadyMine;

  Campaign({
    required this.programId,
    required this.title,
    required this.target,
    required this.rewardText,
    this.productName,
    required this.alreadyMine,
  });

  factory Campaign.fromJson(Map<String, dynamic> j) => Campaign(
        programId: _i(j['program_id']),
        title: _s(j['title']),
        target: _i(j['target_count']),
        rewardText: _s(j['reward_text']),
        productName: _sn(j['product_name']),
        alreadyMine: _i(j['already_mine']) == 1,
      );
}

class Place {
  final int tenantId;
  final String restaurant;
  final String? city;
  final List<Campaign> campaigns;

  Place({required this.tenantId, required this.restaurant, this.city, required this.campaigns});

  factory Place.fromJson(Map<String, dynamic> j) => Place(
        tenantId: _i(j['tenant_id']),
        restaurant: _s(j['restaurant']).isEmpty ? 'NOKTApp restoranı' : _s(j['restaurant']),
        city: _sn(j['city']),
        campaigns: ((j['programs'] as List?) ?? const [])
            .map((e) => Campaign.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(),
      );
}

/// A one-time code, and the moment it stops being valid.
class OneTimeCode {
  final String token;
  final DateTime expiresAt;
  final String? cardCode;

  OneTimeCode({required this.token, required this.expiresAt, this.cardCode});

  Duration get left {
    final d = expiresAt.difference(DateTime.now());
    return d.isNegative ? Duration.zero : d;
  }

  factory OneTimeCode.fromJson(Map<String, dynamic> j) {
    final seconds = _i(j['expires_in']);
    return OneTimeCode(
      token: _s(j['token']),
      /* Timed from THIS phone's clock and the seconds the server granted, not
         from the absolute timestamp it also sends. A phone whose clock is
         twenty minutes out would otherwise show a code as already dead, or as
         alive long after the till has stopped accepting it. */
      expiresAt: DateTime.now().add(Duration(seconds: seconds > 0 ? seconds : 300)),
      cardCode: _sn(j['card_code']),
    );
  }
}
