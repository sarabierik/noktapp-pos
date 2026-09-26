import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/api.dart';
import '../theme.dart';

/// Giriş — and sign-up, on the same screen.
///
/// One screen rather than two, because the guest does not know which one they
/// are. Most of the people who install this were enrolled at a counter months
/// ago: their account already exists, with their stamps on it, and they have
/// never had a password. Making them choose "Giriş" or "Kayıt ol" before
/// anything is known is asking a question the app can answer itself, and getting
/// it wrong sends somebody with four stamps to a screen that creates a second
/// empty account.
///
/// So: the number and the password go in, and the server decides. Its two
/// redirecting answers drive this screen -
///
///   NEEDS_REGISTER  the number is known but has no password. Switch to
///                   sign-up, keep what was typed.
///   NEEDS_PROOF     the number is known AND has stamps on it. Ask for the card
///                   code, because otherwise anyone who can type a phone number
///                   could take the account.
class LoginScreen extends StatefulWidget {
  final VoidCallback onSignedIn;
  const LoginScreen({super.key, required this.onSignedIn});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

enum _Mode { signIn, signUp }

class _LoginScreenState extends State<LoginScreen> {
  final _phone = TextEditingController();
  final _password = TextEditingController();
  final _firstName = TextEditingController();
  final _lastName = TextEditingController();
  final _cardCode = TextEditingController();

  _Mode _mode = _Mode.signIn;
  bool _busy = false;
  bool _needProof = false;
  bool _hidden = true;
  String? _error;
  String? _hint;

  @override
  void dispose() {
    _phone.dispose();
    _password.dispose();
    _firstName.dispose();
    _lastName.dispose();
    _cardCode.dispose();
    super.dispose();
  }

  /// Everything that is not a digit, gone: "0532 111 22 33" and "+90 532 111
  /// 22 33" are the same person typing the same number.
  String get _digits => _phone.text.replaceAll(RegExp(r'\D'), '');

  /// THE ONE SPELLING THAT LEAVES THIS SCREEN.
  ///
  /// 5321112233 - ten digits, no leading zero, no country code. The check
  /// below used to strip 0 and 90 before deciding the number was valid, and
  /// then the RAW digits were sent to the server anyway. So a guest who typed
  /// 0532... passed validation and registered as "05321112233", while the same
  /// guest typing 532... the next time was a different string - and on a
  /// server that keys a guest by their phone number, a different string is a
  /// different person with none of their stamps.
  ///
  /// Normalised once, here, and used for both.
  String get _normalPhone {
    var d = _digits;
    if (d.length == 12 && d.startsWith('90')) d = d.substring(2);
    if (d.length == 11 && d.startsWith('0')) d = d.substring(1);
    return d;
  }

  bool get _phoneLooksRight => RegExp(r'^5\d{9}$').hasMatch(_normalPhone);

  Future<void> _go() async {
    FocusScope.of(context).unfocus();
    if (!_phoneLooksRight) {
      setState(() => _error = 'Telefon numarası 5 ile başlayan 10 hane olmalı.');
      return;
    }
    if (_password.text.length < 6) {
      setState(() => _error = 'Şifre en az 6 karakter olmalı.');
      return;
    }
    if (_mode == _Mode.signUp && _firstName.text.trim().isEmpty) {
      setState(() => _error = 'Adınızı yazın.');
      return;
    }
    setState(() { _busy = true; _error = null; _hint = null; });
    try {
      if (_mode == _Mode.signIn) {
        await Api.instance.login(phone: _normalPhone, password: _password.text);
      } else {
        await Api.instance.register(
          phone: _normalPhone,
          firstName: _firstName.text.trim(),
          lastName: _lastName.text.trim(),
          password: _password.text,
          cardCode: _cardCode.text.trim(),
        );
      }
      if (!mounted) return;
      widget.onSignedIn();
    } on ApiError catch (e) {
      if (!mounted) return;
      switch (e.code) {
        case 'NEEDS_REGISTER':
          setState(() {
            _mode = _Mode.signUp;
            _error = null;
            _hint = 'Bu numara bir restoranda kayıtlı ama şifresi yok. '
                'Adınızı yazıp şifrenizi belirleyin — pullarınız hesabınızda kalır.';
          });
          break;
        case 'NEEDS_PROOF':
          setState(() {
            _mode = _Mode.signUp;
            _needProof = true;
            _error = null;
            _hint = 'Bu numarada toplanmış pullar var. Hesabı devralmak için '
                'NOKTA kartınızdaki kodu girin. Kartınız yoksa pulları verdiğiniz '
                'restorandan isteyebilirsiniz.';
          });
          break;
        case 'ALREADY_REGISTERED':
          setState(() {
            _mode = _Mode.signIn;
            _needProof = false;
            _error = null;
            _hint = 'Bu numara kayıtlı. Şifrenizle giriş yapın.';
          });
          break;
        default:
          setState(() => _error = e.message);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final up = _mode == _Mode.signUp;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const _Mark(),
                  const SizedBox(height: 28),
                  Text(up ? 'Hesabınızı oluşturun' : 'Hoş geldiniz',
                      style: const TextStyle(
                          color: NoktaTheme.text,
                          fontSize: 26,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -0.5)),
                  const SizedBox(height: 8),
                  const Text(
                      'Gittiğiniz restoranların kampanyalarını tek yerde toplayın.',
                      style: TextStyle(color: NoktaTheme.text2, fontSize: 14.5, height: 1.5)),
                  const SizedBox(height: 28),

                  if (_hint != null) _Note(text: _hint!, tone: _Tone.info),
                  if (_hint != null) const SizedBox(height: 16),

                  TextField(
                    controller: _phone,
                    keyboardType: TextInputType.phone,
                    textInputAction: TextInputAction.next,
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[0-9 +()\-]')),
                      LengthLimitingTextInputFormatter(20),
                    ],
                    style: const TextStyle(color: NoktaTheme.text, fontSize: 16),
                    decoration: const InputDecoration(
                      labelText: 'Telefon',
                      hintText: '5xx xxx xx xx',
                      prefixIcon: Icon(Icons.phone_outlined, color: NoktaTheme.text3, size: 20),
                    ),
                  ),
                  const SizedBox(height: 12),

                  if (up) ...[
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _firstName,
                            textCapitalization: TextCapitalization.words,
                            textInputAction: TextInputAction.next,
                            style: const TextStyle(color: NoktaTheme.text, fontSize: 16),
                            decoration: const InputDecoration(labelText: 'Ad'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: TextField(
                            controller: _lastName,
                            textCapitalization: TextCapitalization.words,
                            textInputAction: TextInputAction.next,
                            style: const TextStyle(color: NoktaTheme.text, fontSize: 16),
                            decoration: const InputDecoration(labelText: 'Soyad'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                  ],

                  TextField(
                    controller: _password,
                    obscureText: _hidden,
                    textInputAction:
                        (_needProof && up) ? TextInputAction.next : TextInputAction.done,
                    onSubmitted: (_) => _busy ? null : _go(),
                    style: const TextStyle(color: NoktaTheme.text, fontSize: 16),
                    decoration: InputDecoration(
                      labelText: up ? 'Belirleyeceğiniz şifre' : 'Şifre',
                      prefixIcon:
                          const Icon(Icons.lock_outline_rounded, color: NoktaTheme.text3, size: 20),
                      suffixIcon: IconButton(
                        icon: Icon(_hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                            color: NoktaTheme.text3, size: 20),
                        onPressed: () => setState(() => _hidden = !_hidden),
                      ),
                    ),
                  ),

                  if (up && _needProof) ...[
                    const SizedBox(height: 12),
                    TextField(
                      controller: _cardCode,
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => _busy ? null : _go(),
                      style: const TextStyle(
                          color: NoktaTheme.text, fontSize: 15, fontFamily: 'monospace'),
                      decoration: const InputDecoration(
                        labelText: 'NOKTA kart kodu',
                        hintText: 'kartınızın arkasındaki uzun kod',
                        prefixIcon:
                            Icon(Icons.badge_outlined, color: NoktaTheme.text3, size: 20),
                      ),
                    ),
                  ],

                  if (_error != null) const SizedBox(height: 16),
                  if (_error != null) _Note(text: _error!, tone: _Tone.bad),

                  const SizedBox(height: 22),
                  FilledButton(
                    onPressed: _busy ? null : _go,
                    child: _busy
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white))
                        : Text(up ? 'Hesabı oluştur' : 'Giriş yap'),
                  ),
                  const SizedBox(height: 10),
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => setState(() {
                              _mode = up ? _Mode.signIn : _Mode.signUp;
                              _needProof = false;
                              _error = null;
                              _hint = null;
                            }),
                    child: Text(up ? 'Hesabım var, giriş yapayım' : 'Hesabım yok, kayıt olayım'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Mark extends StatelessWidget {
  const _Mark();
  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 54,
          height: 54,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [NoktaTheme.orange, NoktaTheme.orangeDark],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(16),
          ),
          alignment: Alignment.center,
          child: const Text('N',
              style: TextStyle(
                  color: Colors.white, fontSize: 28, fontWeight: FontWeight.w900, height: 1)),
        ),
        const SizedBox(width: 14),
        const Text('NOKTA',
            style: TextStyle(
                color: NoktaTheme.text,
                fontSize: 24,
                fontWeight: FontWeight.w900,
                letterSpacing: 3)),
      ],
    );
  }
}

enum _Tone { info, bad }

class _Note extends StatelessWidget {
  final String text;
  final _Tone tone;
  const _Note({required this.text, required this.tone});

  @override
  Widget build(BuildContext context) {
    final bad = tone == _Tone.bad;
    final tint = bad ? const Color(0xFFF87171) : NoktaTheme.orange;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
      decoration: BoxDecoration(
        color: tint.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: tint.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(bad ? Icons.error_outline_rounded : Icons.info_outline_rounded,
              size: 19, color: tint),
          const SizedBox(width: 11),
          Expanded(
            child: Text(text,
                style: TextStyle(color: bad ? const Color(0xFFFCA5A5) : NoktaTheme.text,
                    fontSize: 13.5, height: 1.45)),
          ),
        ],
      ),
    );
  }
}
