# 1.5.0 — the app stops committing to one address

## The bug you found

Your PC moved to `192.168.2.136`. The phone's browser opened it. The app kept
calling `172.16.3.253` — an address from hours earlier, on a network that no
longer existed — and timed out against it forever.

This was the code:

```dart
final typed = await manualBase();
if (typed != null) {
  _lanBase = typed;
  return typed;        // returned without ever checking anything is there
}
```

A typed address was trusted permanently and never re-tested. Type one in an
office on Monday and the app is still calling it in a restaurant on Friday.
Nothing a waiter could do in the app would shift it, because the bad value was
what the app reached for first, every single time.

And the search that should have rescued it could not: the sweep fired all 254
addresses at once with a 700 ms fuse. A phone is not a server — Android
throttles that many sockets, most probes never really went out, and the ones
that did had under a second. It reported "no till here" while the till answered
the phone's own browser instantly.

## What changed

**A remembered address has to earn its place.** It is checked on every use, and
when it stops answering it is thrown away instead of retried into the next
restaurant.

**The till says where it is.** `/api/mobile/ping` and `/api/mobile/bootstrap`
now return every address the PC is reachable on, ranked. The app keeps that
list and tries all of them. The day the PC changes network, the first
successful call — over the LAN or through the relay — teaches the phone where
the till went. Nobody types anything.

**The QR's addresses are all kept**, not just whichever one happened to answer
first. The address that works in the kitchen is not always the one that works
in the garden.

**The sweep works.** Thirty-two at a time, 1.5 s each, nearest-address first.
About four seconds for a whole subnet, and it actually finds things.

## Order of attack now

1. the address that worked last time — if it still answers
2. a typed or scanned address — checked, and forgotten if dead
3. every address the till has ever named
4. a search of the local network
5. the cloud relay

## Still true, and still wrong

**Pairing can only happen over the LAN.** `_pair` posts to a LAN address, full
stop. So a phone that cannot reach the till locally can never pair, and because
it can never pair it can never use the relay either — the fallback is behind the
door it cannot open.

The fix is for the QR to carry the tenant as well as the address, so pairing can
go through the relay like everything else and the LAN becomes an optimisation
rather than a requirement. That is a change to the till, the panel and the app
together, and it is the one that ends this class of problem for good.
