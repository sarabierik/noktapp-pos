import 'package:flutter/material.dart';
import '../services/api.dart';
import '../theme.dart';
import 'scan_screen.dart';
import 'tables_screen.dart';

/// First run.
///
/// Two ways in, and they are deliberately not equal on this screen. Scanning
/// the till's symbol carries the address AND the identity, so it needs no
/// password, no username and no search - one tap and the waiter is working.
/// Typing the six digits is the fallback for a phone with no camera or a
/// camera that will not focus on a glossy screen, and it still asks for the
/// credentials, because six digits shown across a dining room are not a
/// secret worth trusting on their own.
class PairScreen extends StatefulWidget {
  const PairScreen({super.key});
  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _code = TextEditingController();
  final _user = TextEditingController();
  final _pass = TextEditingController();
  final _name = TextEditingController(text: 'Garson telefonu');
  final _addr = TextEditingController();
  bool _busy = false;
  bool _manual = false;          // the "kasa adresi" field is open
  bool _typing = false;          // the six digit form is open
  String? _error;
  String? _addrNote;             // what happened when the address was tried
  String _status = '';

  /// Camera -> token -> paired. Nothing is typed and nothing is searched for.
  Future<void> _scan() async {
    setState(() { _error = null; _addrNote = null; });
    final qr = await Navigator.of(context).push<PairQr>(
        MaterialPageRoute(builder: (_) => const ScanScreen()));
    if (qr == null || !mounted) return;

    setState(() { _busy = true; _status = 'Kasaya baglaniliyor...'; });
    try {
      await Api.instance.pairWithQr(qr, phoneName: _name.text.trim());
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (_) => const TablesScreen()));
    } catch (e) {
      /*
       * The two failures a waiter actually hits, told apart. A symbol that has
       * gone stale is a ten second fix at the till; a phone on the wrong wifi
       * is not, and telling somebody to "get a new code" when the code was
       * fine sends them back and forth across the restaurant.
       */
      final msg = e.toString();
      setState(() {
        _busy = false;
        _status = '';
        _error = msg.contains('Kasa bulunamadi')
            ? 'Karekod okundu ama kasaya ulasilamadi. Telefon restoranin wifi agina bagli mi?'
            : msg;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pair() async {
    setState(() { _busy = true; _error = null; _addrNote = null; _status = 'Kasa araniyor...'; });
    try {
      /*
       * A typed address is tried FIRST and on its own. Discovery is multicast,
       * and a network that drops multicast - guest wifi with client isolation,
       * an emulator's NAT - will never find a till that is sitting there
       * answering. Somebody who has typed the address off the till's own screen
       * has better information than the search does.
       */
      if (_addr.text.trim().isNotEmpty) {
        setState(() => _status = 'Kasa adresi deneniyor...');
        final okAddr = await Api.instance.setManualBase(_addr.text);
        if (!okAddr) {
          setState(() {
            _busy = false;
            _status = '';
            _addrNote = 'Bu adreste kasa bulunamadi. Kasa acik mi, telefon ayni agda mi?';
          });
          return;
        }
      }
      await Api.instance.pair(
        code: _code.text.trim(),
        username: _user.text.trim(),
        password: _pass.text,
        phoneName: _name.text.trim(),
      );
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (_) => const TablesScreen()));
    } catch (e) {
      setState(() { _error = e.toString(); _status = ''; });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const SizedBox(height: 24),
            Row(children: [
              Container(width: 44, height: 44,
                decoration: BoxDecoration(color: NokTheme.orange, borderRadius: BorderRadius.circular(12)),
                child: const Center(child: CircleAvatar(radius: 7, backgroundColor: Colors.white))),
              const SizedBox(width: 12),
              const Text('NOKTApp Garson',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: -.3)),
            ]),
            const SizedBox(height: 28),
            const Text('Kasaya baglan', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700, letterSpacing: -.5)),
            const SizedBox(height: 8),
            const Text(
              'Kasadaki uygulamada Ayarlar > Cihazlar > Telefonlar bolumunden "Telefon bagla" '
              'deyin, personeli secin ve ekranda cikan karekodu bu telefona okutun. Ilk baglanti '
              'icin restoranin wifi agina bagli olmalisiniz.',
              style: TextStyle(color: NokTheme.ink2, height: 1.5)),
            const SizedBox(height: 24),
            if (_error != null)
              Container(
                padding: const EdgeInsets.all(12),
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                  color: const Color(0xFFFDECEA),
                  border: Border.all(color: const Color(0xFFF5C6C2)),
                  borderRadius: BorderRadius.circular(10)),
                child: Text(_error!, style: const TextStyle(color: Color(0xFFB42318)))),
            TextField(controller: _name, decoration: const InputDecoration(labelText: 'Bu telefonun adi')),
            const SizedBox(height: 20),

            /* The whole flow, in one button. */
            FilledButton.icon(
              onPressed: _busy ? null : _scan,
              icon: const Icon(Icons.qr_code_scanner),
              label: Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Text(_busy && _status.isNotEmpty ? _status : 'Karekodu okut',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              ),
            ),
            const SizedBox(height: 10),
            const Text('Karekodu okuttugunuzda sifre sorulmaz.',
                textAlign: TextAlign.center,
                style: TextStyle(color: NokTheme.ink3, fontSize: 12.5)),
            const SizedBox(height: 18),

            /*
             * Folded away, and on purpose. A waiter who can scan should never
             * see a username field: the moment both paths are on screen at
             * once, half of them will type a code they did not need to type
             * and then ask what their password is.
             */
            if (!_typing)
              TextButton(
                onPressed: () => setState(() => _typing = true),
                child: const Text('Kamera yok mu? Kodu elle yaz',
                    style: TextStyle(color: NokTheme.orangeDark, fontWeight: FontWeight.w600)),
              ),

            if (_typing) ...[
              const Divider(height: 28),
              const Text('Alti haneli kod ile baglan',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
              const SizedBox(height: 4),
              const Text('Bu yolda kasadaki kullanici adiniz ve telefon sifreniz gerekir.',
                  style: TextStyle(color: NokTheme.ink3, fontSize: 12.5, height: 1.4)),
              const SizedBox(height: 14),
              TextField(
                controller: _code,
                keyboardType: TextInputType.number,
                maxLength: 6,
                style: const TextStyle(fontSize: 26, letterSpacing: 8, fontWeight: FontWeight.w700),
                textAlign: TextAlign.center,
                decoration: const InputDecoration(labelText: 'Baglanti kodu', counterText: '')),
              const SizedBox(height: 12),
              TextField(controller: _user, decoration: const InputDecoration(labelText: 'Kullanici adi')),
              const SizedBox(height: 12),
              TextField(controller: _pass, obscureText: true,
                  decoration: const InputDecoration(labelText: 'Sifre')),
              const SizedBox(height: 14),
            /*
             * Folded away by default: on a restaurant's own wifi the app finds
             * the till by itself and an IP address box is one more thing for a
             * waiter to be frightened of. It is one tap away because the till's
             * own screen tells people to use it.
             */
              if (!_manual)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: () => setState(() => _manual = true),
                    child: const Text('Kasa bulunamiyor mu? Adresi elle gir',
                        style: TextStyle(color: NokTheme.orangeDark, fontWeight: FontWeight.w600)),
                  ),
                ),
              if (_manual) ...[
                TextField(
                  controller: _addr,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Kasa adresi',
                    hintText: '172.16.2.31:7451',
                    helperText: 'Kasadaki Ayarlar > Cihazlar > Telefonlar ekraninda yazar.',
                    helperMaxLines: 2),
                ),
                if (_addrNote != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(_addrNote!,
                        style: const TextStyle(color: Color(0xFFB42318), fontSize: 12.5)),
                  ),
              ],
              const SizedBox(height: 20),
              FilledButton(onPressed: _busy ? null : _pair,
                  child: Text(_busy ? (_status.isEmpty ? 'Baglaniyor...' : _status) : 'Baglan')),
            ],
            const SizedBox(height: 16),
            const Text('Sorun yasarsaniz: destek@noktapp.com · 0850 84 00 654',
                textAlign: TextAlign.center, style: TextStyle(color: NokTheme.ink3, fontSize: 12.5)),
          ]),
        ),
      ),
    );
  }
}
