import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api.dart';
import '../theme.dart';

/// DID THE SLIP COME OUT?
///
/// Without this the only way to answer that is to walk to the kitchen, and a
/// handheld that makes the waiter walk to the kitchen has given back the
/// minute it was bought to save. A failed job is one tap from being sent
/// again - the paper ran out, somebody refilled it, and nothing was lost.
class PrintJobsScreen extends StatefulWidget {
  const PrintJobsScreen({super.key});
  @override
  State<PrintJobsScreen> createState() => _PrintJobsScreenState();
}

class _PrintJobsScreenState extends State<PrintJobsScreen> {
  List<PrintJob> jobs = [];
  bool loading = true;
  String? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { loading = true; error = null; });
    try {
      final rows = await Api.instance.printJobs();
      if (!mounted) return;
      setState(() {
        jobs = rows.map((j) => PrintJob.fromJson(j as Map<String, dynamic>)).toList();
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { error = '$e'; loading = false; });
    }
  }

  Future<void> _retry(PrintJob j) async {
    try {
      await Api.instance.retryPrintJob(j.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Yazdırma tekrar kuyruğa alındı')));
      _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _retryAllFailed() async {
    final failed = jobs.where((j) => j.failed).toList();
    for (final j in failed) {
      try { await Api.instance.retryPrintJob(j.id); } catch (_) {}
    }
    _load();
  }

  Color _colour(PrintJob j) =>
      j.failed ? const Color(0xFFD93025) : (j.done ? const Color(0xFF0F9D58) : NokTheme.ink3);

  @override
  Widget build(BuildContext context) {
    final failedCount = jobs.where((j) => j.failed).length;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Yazdırma'),
        actions: [
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : error != null
              ? Center(
                  child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(error!, textAlign: TextAlign.center)))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: jobs.isEmpty
                      ? ListView(children: const [
                          SizedBox(height: 120),
                          Center(child: Text('Henüz yazdırma yok.',
                              style: TextStyle(color: NokTheme.ink3))),
                        ])
                      : ListView.separated(
                          padding: const EdgeInsets.all(12),
                          itemCount: jobs.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 8),
                          itemBuilder: (_, i) {
                            final j = jobs[i];
                            return Material(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(12),
                              child: InkWell(
                                borderRadius: BorderRadius.circular(12),
                                onTap: j.failed ? () => _retry(j) : null,
                                child: Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
                                  decoration: BoxDecoration(
                                      border: Border.all(color: NokTheme.line),
                                      borderRadius: BorderRadius.circular(12)),
                                  child: Row(children: [
                                    Expanded(
                                        child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: [
                                          Text(j.label,
                                              style: const TextStyle(
                                                  fontWeight: FontWeight.w600, fontSize: 15)),
                                          const SizedBox(height: 2),
                                          Text(j.createdAt.replaceFirst('T', ' '),
                                              style: const TextStyle(
                                                  color: NokTheme.ink3, fontSize: 12)),
                                        ])),
                                    Text(j.statusLabel,
                                        style: TextStyle(
                                            color: _colour(j),
                                            fontWeight: FontWeight.w700,
                                            fontSize: 12.5)),
                                    if (j.failed) ...[
                                      const SizedBox(width: 8),
                                      const Icon(Icons.refresh, size: 18, color: NokTheme.orangeDark),
                                    ],
                                  ]),
                                ),
                              ),
                            );
                          }),
                ),
      bottomNavigationBar: failedCount == 0
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: SizedBox(
                  height: 50,
                  child: FilledButton(
                    onPressed: _retryAllFailed,
                    child: Text('$failedCount hatalı işi tekrar dene'),
                  ),
                ),
              ),
            ),
    );
  }
}
