import 'package:flutter/material.dart';
import 'cards_screen.dart';
import 'discover_screen.dart';
import 'profile_screen.dart';
import 'qr_screen.dart';

/// The shell: four tabs, and the karekod is one of them rather than a button
/// buried on a card.
///
/// Pulling the code out to its own tab is the difference between a guest who
/// finds it at the counter and one who hands the cashier their phone open on
/// the wrong screen. It is the one thing they do in front of another person, so
/// it is one tap from anywhere.
///
/// The tabs keep their state - a scrolled list stays scrolled - but Kartlarım
/// refreshes when it comes back into view, because the most likely reason a
/// guest has just left the karekod tab is that a stamp was written a second ago.
class HomeScreen extends StatefulWidget {
  final VoidCallback onSignedOut;
  const HomeScreen({super.key, required this.onSignedOut});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;
  final _cards = GlobalKey<CardsScreenState>();
  final _discover = GlobalKey<DiscoverScreenState>();
  final _profile = GlobalKey<ProfileScreenState>();

  static const _titles = ['Kartlarım', 'Karekod', 'Keşfet', 'Profil'];

  void _select(int i) {
    if (i == _tab) return;
    setState(() => _tab = i);
    if (i == 0) _cards.currentState?.refresh();
    if (i == 2) _discover.currentState?.refresh();
    if (i == 3) _profile.currentState?.refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_titles[_tab]),
        actions: [
          if (_tab == 0)
            IconButton(
              tooltip: 'Yenile',
              icon: const Icon(Icons.refresh_rounded),
              onPressed: () => _cards.currentState?.refresh(),
            ),
        ],
      ),
      body: SafeArea(
        child: IndexedStack(
          index: _tab,
          children: [
            CardsScreen(key: _cards, onShowCode: () => _select(1)),
            const QrScreen(),
            DiscoverScreen(key: _discover),
            ProfileScreen(key: _profile, onSignedOut: widget.onSignedOut),
          ],
        ),
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _tab,
        onTap: _select,
        items: const [
          BottomNavigationBarItem(
              icon: Icon(Icons.style_outlined),
              activeIcon: Icon(Icons.style_rounded),
              label: 'Kartlarım'),
          BottomNavigationBarItem(
              icon: Icon(Icons.qr_code_2_outlined),
              activeIcon: Icon(Icons.qr_code_2_rounded),
              label: 'Karekod'),
          BottomNavigationBarItem(
              icon: Icon(Icons.explore_outlined),
              activeIcon: Icon(Icons.explore_rounded),
              label: 'Keşfet'),
          BottomNavigationBarItem(
              icon: Icon(Icons.person_outline_rounded),
              activeIcon: Icon(Icons.person_rounded),
              label: 'Profil'),
        ],
      ),
    );
  }
}
