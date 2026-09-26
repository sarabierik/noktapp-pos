import 'package:flutter/material.dart';
import '../services/api.dart';
import '../theme.dart';
import '../widgets/bits.dart';
import 'history_screen.dart';

/// Profil — the guest's own details, and the two things the app stores must let
/// them do: sign out, and delete the account for good.
///
/// Account deletion is reachable in two taps from here and is not hidden behind
/// a support e-mail. Both stores require that; more to the point, an app that
/// makes leaving hard is an app people distrust with a phone number.
class ProfileScreen extends StatefulWidget {
  final VoidCallback onSignedOut;
  const ProfileScreen({super.key, required this.onSignedOut});

  @override
  State<ProfileScreen> createState() => ProfileScreenState();
}

class ProfileScreenState extends State<ProfileScreen> {
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    refresh();
  }

  Future<void> refresh() async {
    try {
      await Api.instance.profile();
      if (!mounted) return;
      setState(() { _error = null; _loading = false; });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() { _error = e.message; _loading = false; });
    }
  }

  Future<void> _editDetails() async {
    final me = Api.instance.me;
    if (me == null) return;
    final first = TextEditingController(text: me.firstName);
    final last = TextEditingController(text: me.lastName ?? '');
    final email = TextEditingController(text: me.email ?? '');
    final ok = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: NoktaTheme.card,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => _Sheet(
        title: 'Bilgilerim',
        children: [
          TextField(
            controller: first,
            textCapitalization: TextCapitalization.words,
            style: const TextStyle(color: NoktaTheme.text),
            decoration: const InputDecoration(labelText: 'Ad'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: last,
            textCapitalization: TextCapitalization.words,
            style: const TextStyle(color: NoktaTheme.text),
            decoration: const InputDecoration(labelText: 'Soyad'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: email,
            keyboardType: TextInputType.emailAddress,
            style: const TextStyle(color: NoktaTheme.text),
            decoration: const InputDecoration(labelText: 'E-posta (isteğe bağlı)'),
          ),
          const SizedBox(height: 10),
          const Text(
              'Telefon numaranız burada değiştirilemez — restoranlar sizi o numarayla '
              'tanıyor. Değişmesi gerekiyorsa bize yazın.',
              style: TextStyle(color: NoktaTheme.text3, fontSize: 12.5, height: 1.45)),
          const SizedBox(height: 18),
          FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Kaydet')),
        ],
      ),
    );
    /* The sheet is gone by now, but a TextEditingController is a ChangeNotifier
       and holds its listeners until somebody disposes it. Three of them leak
       every time this sheet is opened and closed, which on a screen a guest
       pokes at is a slow, invisible drip. */
    try {
      if (ok != true) return;
      await Api.instance.saveProfile(
        firstName: first.text.trim(),
        lastName: last.text.trim(),
        email: email.text.trim(),
      );
      if (!mounted) return;
      setState(() {});
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Kaydedildi')));
    } on ApiError catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      first.dispose();
      last.dispose();
      email.dispose();
    }
  }

  Future<void> _changePassword() async {
    final current = TextEditingController();
    final next = TextEditingController();
    final ok = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: NoktaTheme.card,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => _Sheet(
        title: 'Şifre değiştir',
        children: [
          TextField(
            controller: current,
            obscureText: true,
            style: const TextStyle(color: NoktaTheme.text),
            decoration: const InputDecoration(labelText: 'Mevcut şifre'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: next,
            obscureText: true,
            style: const TextStyle(color: NoktaTheme.text),
            decoration: const InputDecoration(labelText: 'Yeni şifre (en az 6 karakter)'),
          ),
          const SizedBox(height: 10),
          const Text('Şifreniz değişince diğer telefonlardaki oturumlar kapanır.',
              style: TextStyle(color: NoktaTheme.text3, fontSize: 12.5, height: 1.45)),
          const SizedBox(height: 18),
          FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Değiştir')),
        ],
      ),
    );
    try {
      if (ok != true) return;
      if (next.text.length < 6) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Yeni şifre en az 6 karakter olmalı')));
        return;
      }
      await Api.instance.changePassword(current.text, next.text);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Şifreniz değişti')));
    } on ApiError catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      current.dispose();
      next.dispose();
    }
  }

  Future<void> _signOut() async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: NoktaTheme.card,
        title: const Text('Çıkış yapılsın mı?', style: TextStyle(color: NoktaTheme.text)),
        content: const Text('Kartlarınız silinmez, tekrar giriş yaptığınızda yerinde olur.',
            style: TextStyle(color: NoktaTheme.text2)),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Vazgeç')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Çıkış yap')),
        ],
      ),
    );
    if (yes != true) return;
    await Api.instance.logout();
    if (!mounted) return;
    widget.onSignedOut();
  }

  /// Two steps on purpose: read what goes, then type the password.
  Future<void> _deleteAccount() async {
    final understood = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: NoktaTheme.card,
        title: const Text('Hesabımı sil', style: TextStyle(color: NoktaTheme.text)),
        content: const Text(
            'Adınız, telefonunuz, e-postanız, şifreniz, kart kodunuz ve hareket '
            'geçmişiniz kalıcı olarak silinir. Geri alınamaz.\n\n'
            'Pul bakiyeleri restoranların kendi muhasebe kaydı olduğu için isimsiz '
            'olarak kalır. Sizi daha önce ağırlamış restoranların kendi '
            'bilgisayarlarındaki yerel kayıtları buradan silemiyoruz.',
            style: TextStyle(color: NoktaTheme.text2, height: 1.5)),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Vazgeç')),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: const Color(0xFFF87171)),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Devam et'),
          ),
        ],
      ),
    );
    if (understood != true || !mounted) return;

    final pw = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: NoktaTheme.card,
        title: const Text('Şifrenizi girin', style: TextStyle(color: NoktaTheme.text)),
        content: TextField(
          controller: pw,
          obscureText: true,
          autofocus: true,
          style: const TextStyle(color: NoktaTheme.text),
          decoration: const InputDecoration(labelText: 'Şifre'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Vazgeç')),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: const Color(0xFFF87171)),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Hesabımı sil'),
          ),
        ],
      ),
    );
    try {
      if (go != true) return;
      await Api.instance.deleteAccount(pw.text);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Hesabınız silindi.')));
      widget.onSignedOut();
    } on ApiError catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      pw.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = Api.instance.me;
    if (_loading && me == null) return const Loading();
    if (me == null) {
      return Problem(
          message: _error ?? 'Profil okunamadı.',
          onRetry: () { setState(() { _loading = true; _error = null; }); refresh(); });
    }

    return RefreshIndicator(
      color: NoktaTheme.orange,
      backgroundColor: NoktaTheme.card,
      onRefresh: refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 10, 18, 32),
        children: [
          Row(
            children: [
              Container(
                width: 62,
                height: 62,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [NoktaTheme.orange, NoktaTheme.orangeDark],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(18),
                ),
                alignment: Alignment.center,
                child: Text(me.initials,
                    style: const TextStyle(
                        color: Colors.white, fontSize: 24, fontWeight: FontWeight.w800)),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(me.fullName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            color: NoktaTheme.text, fontSize: 20, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Text('0${me.phone}',
                        style: const TextStyle(color: NoktaTheme.text2, fontSize: 14)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 26),
          Panel(
            title: 'Hesap',
            children: [
              Line(
                  icon: Icons.person_outline_rounded,
                  label: 'Bilgilerim',
                  onTap: _editDetails),
              Line(
                  icon: Icons.history_rounded,
                  label: 'Geçmiş',
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => Scaffold(
                            appBar: AppBar(title: const Text('Geçmiş')),
                            body: const HistoryScreen(),
                          )))),
              Line(
                  icon: Icons.lock_outline_rounded,
                  label: 'Şifre değiştir',
                  onTap: _changePassword),
            ],
          ),
          const SizedBox(height: 20),
          Panel(
            title: 'NOKTA',
            children: [
              if (me.memberSince != null)
                Line(
                    icon: Icons.calendar_today_outlined,
                    label: 'Üyelik',
                    value: trWhen(me.memberSince).split(',').first),
              const Line(icon: Icons.info_outline_rounded, label: 'Sürüm', value: '1.0.0'),
            ],
          ),
          const SizedBox(height: 20),
          Panel(
            children: [
              Line(icon: Icons.logout_rounded, label: 'Çıkış yap', onTap: _signOut),
              Line(
                  icon: Icons.delete_outline_rounded,
                  label: 'Hesabımı sil',
                  tint: const Color(0xFFF87171),
                  onTap: _deleteAccount),
            ],
          ),
        ],
      ),
    );
  }
}

class _Sheet extends StatelessWidget {
  final String title;
  final List<Widget> children;
  const _Sheet({required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
          22, 22, 22, 22 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title,
              style: const TextStyle(
                  color: NoktaTheme.text, fontSize: 19, fontWeight: FontWeight.w700)),
          const SizedBox(height: 18),
          ...children,
        ],
      ),
    );
  }
}
