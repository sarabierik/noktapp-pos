/// Small value types shared by the screens.
class Product {
  final int id;
  final String name;
  final double price;
  final double vatRate;
  final bool trackStock;
  final double stock;
  Product.fromJson(Map<String, dynamic> j)
      : id = j['id'] as int,
        name = j['name'] as String,
        price = double.tryParse('${j['price']}') ?? 0,
        vatRate = double.tryParse('${j['vat_rate']}') ?? 0,
        trackStock = (j['track_stock'] ?? 0) == 1,
        stock = double.tryParse('${j['stock'] ?? 0}') ?? 0;
}

class Category {
  final int id;
  final String name;
  final List<Product> products;
  Category.fromJson(Map<String, dynamic> j)
      : id = j['id'] as int,
        name = j['name'] as String,
        products = ((j['products'] ?? []) as List)
            .map((p) => Product.fromJson(p as Map<String, dynamic>))
            .toList();
}

class TableInfo {
  final int id;
  final int? zoneId;
  final String name;
  final int openBills;
  final double openTotal;

  /// "A, B" - the labels of the bills open on this table, as the floor plan
  /// already sends them. "3 adisyon" tells a waiter nothing about which is
  /// whose; "3 adisyon - A, B, C" lets him decide before he even taps.
  final String labels;

  /// Joined tables carry ONE bill for the whole party, and the plan already
  /// says which. Without this the phone opens a second adisyon on masa 5 and
  /// the group is charged twice for one dinner - the till has guarded this
  /// for weeks and the id costs no extra request.
  final int? groupOrderId;

  TableInfo.fromJson(Map<String, dynamic> j)
      : id = j['id'] as int,
        zoneId = j['zone_id'] as int?,
        name = j['name'] as String,
        openBills = (j['open_bills'] ?? 0) as int,
        openTotal = double.tryParse('${j['open_total'] ?? 0}') ?? 0,
        labels = (j['labels'] ?? '').toString(),
        groupOrderId =
            j['group_order_id'] == null ? null : int.tryParse('${j['group_order_id']}');
  bool get busy => openBills > 0;
}

class Zone {
  final int id;
  final String name;
  Zone.fromJson(Map<String, dynamic> j) : id = j['id'] as int, name = j['name'] as String;
}

/// One adisyon that is open on a table.
///
/// A table is not a bill. Two couples on a six-top are two bills, and the
/// waiter has to be able to say which one he means - which is why the label
/// matters more than the id here: nobody at a table says "adisyon 10042".
class OpenBill {
  final int id;
  final int adisyonNo;
  final String label;      // '' for the first bill, then A, B, C...
  final double total;
  final DateTime? openedAt;

  OpenBill.fromJson(Map<String, dynamic> j)
      : id = int.tryParse('${j['id']}') ?? 0,
        adisyonNo = int.tryParse('${j['adisyon_no']}') ?? 0,
        label = (j['bill_label'] ?? '').toString().trim(),
        // MySQL hands DECIMAL back as a string, so this must be parsed and
        // not cast - a cast here threw on every busy table.
        total = double.tryParse('${j['grand_total']}') ?? 0,
        openedAt = DateTime.tryParse('${j['opened_at']}');

  /// The short name for a tab strip: the label if the bill has one, the
  /// adisyon number if it does not.
  String get shortName => label.isEmpty ? '#$adisyonNo' : label;

  /// The full name for the chooser, where there is room for both.
  String get title => label.isEmpty ? 'Adisyon #$adisyonNo' : '$label - Adisyon #$adisyonNo';

  /// How long the party has been sitting. Which of two bills is "the one that
  /// has been here an hour" is often the only thing the waiter remembers.
  String get age {
    final t = openedAt;
    if (t == null) return '';
    final m = DateTime.now().difference(t).inMinutes;
    // a phone whose clock runs ahead of the till would otherwise print "-3 dk"
    if (m < 1) return 'az once acildi';
    if (m < 60) return '$m dk once acildi';
    final h = m ~/ 60;
    final rest = m % 60;
    return rest == 0 ? '$h saat once acildi' : '$h saat $rest dk once acildi';
  }
}

/// The answer to "which adisyon does this round belong to?".
///
/// Three answers, and the difference between them is money:
///   existing(id) - this named bill, and nothing else
///   newBill()    - open ANOTHER bill on this table (force_new)
///   tableBill()  - whatever bill this table has; only ever correct when the
///                  table has exactly one, and only ever chosen out loud
class BillChoice {
  final int? orderId;
  final bool isNew;
  const BillChoice.existing(this.orderId) : isNew = false;
  const BillChoice.newBill() : orderId = null, isNew = true;
  const BillChoice.tableBill() : orderId = null, isNew = false;
}

/// A line the waiter has typed but not yet sent.
class DraftLine {
  final Product product;
  /// Halves, because half a portion is a real thing a Turkish kitchen sells.
  double qty;
  String? note;
  DraftLine(this.product, {this.qty = 1, this.note});
  double get total => qty * product.price;
}


/// A kitchen or a bar - where a line is printed and shown.
class Station {
  final int id;
  final String name;
  final String outputMode;
  Station.fromJson(Map<String, dynamic> j)
      : id = j['id'] as int,
        name = '${j['name'] ?? ''}',
        outputMode = '${j['output_mode'] ?? 'screen'}';
}

/// One receipt the till was asked to print, and whether it came out.
///
/// A waiter who has to walk to the kitchen to find out whether the slip
/// printed has lost the minute the handset was bought to save.
class PrintJob {
  final int id;
  final String status;
  final String jobType;
  final int? orderId;
  final String stationName;
  final String createdAt;
  PrintJob.fromJson(Map<String, dynamic> j)
      : id = j['id'] as int,
        status = '${j['status'] ?? ''}',
        jobType = '${j['job_type'] ?? ''}',
        orderId = j['order_id'] == null ? null : int.tryParse('${j['order_id']}'),
        stationName = '${j['station_name'] ?? ''}',
        createdAt = '${j['created_at'] ?? ''}';

  bool get failed => status == 'failed' || status == 'error';
  bool get done => status == 'printed' || status == 'sent' || status == 'done';
  bool get waiting => !failed && !done;

  String get label {
    final what = jobType.contains('bill') || jobType.contains('hesap')
        ? 'Hesap'
        : (stationName.isNotEmpty ? 'Mutfak · $stationName' : 'Mutfak');
    return orderId == null ? what : '$what · #$orderId';
  }

  String get statusLabel =>
      failed ? 'hata' : (done ? 'yazdırıldı' : 'kuyrukta');
}
