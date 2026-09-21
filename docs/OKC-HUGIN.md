# Hugin PC Link — what is built, what is proven, what is missing

Source: **developer.hugin.com.tr**, PC Link API v1, read 21 September 2026
(Genel Bakış, Ortam Bilgisi, Kimlik Doğrulama, and the Cloud Link overview).

---

## The short version

Hugin publishes its protocol openly and **there is no SDK and no DLL to
obtain**. It is HTTPS REST on the device's own address. The adapter in
`pos-service/src/fiscal/adapters/hugin.js` is written to that documentation,
field for field, and 29 checks run it against a local server that behaves the
way the documentation says a device does.

**No Hugin device has ever answered this code.** Reading a specification
correctly and having a terminal print a legal receipt are different claims, and
only the second one is worth anything to a restaurant being audited. That
distinction is recorded in the code — `PROTOCOL_SOURCE.hugin.deviceProven` is
`false` — and the tests assert that it stays false.

## What replaced what

The old Hugin adapter was the generic GMP-3 client on TCP port 7500, with
command names (`cmd`, `params`, `transactionId`) that I invented to a plausible
shape because no specification was in hand. Hugin does not speak that. It
speaks:

| | |
|---|---|
| Transport | HTTPS, port **4443**, on the device's LAN address |
| API | `/v1`, JSON |
| Auth | three headers, every request |
| Envelope | `{status: SUCCESS\|ERROR, data, error{code,title,description}, metadata}` |

`Profilo` was inheriting Hugin's behaviour on the assumption that Profilo
devices run Hugin firmware. Now that Hugin is real, that assumption would have
become a claim, so Profilo was moved back to the unverified GMP-3 path where it
cannot reach a device until somebody proves the protocol.

## The three headers

```
X-SoftwareId   the integrator's VKN, from the Hugin integration contract
X-HardwareId   a value unique to this PC — Hugin recommends its MAC
X-SerialNo     the device's mali sicil no, learned at pairing
```

Any one of them wrong and the device refuses. The same VKN is typed into the
device's own screen (Uygulama Merkezi → Entegrasyon → PC Link) before pairing.

**If the PC is replaced, its MAC changes and the pairing breaks** — Hugin's
documentation says this needs a service visit. `primaryMac()` therefore ignores
virtual interfaces (Docker, VPN, Hyper-V) and sorts what is left, so the value
cannot drift between reboots.

## Pairing

The device shows "Eşleşme bekleniyor" and its address. Then one request:

```
GET /v1/settings          with SoftwareId + HardwareId, no SerialNo
→ data.serialNo
```

`POST /api/okc/devices/{id}/pair` does this and records the serial, the
firmware version (`metadata.sfaVersion`) and the certificate. Re-pairing an
already-paired device requires typing its serial, the same as opening
production — a silent re-pair could move a till onto a different terminal with
one click.

**Pairing is not permission to trade.** `production_enabled` and the capability
profile are untouched by it. "The device answers us" is a much smaller claim
than "this device may print a legal receipt for money."

## The sale

Two calls, exactly as documented:

```
POST /v1/documents            {"docCategory": "SALE"}     → documentId, OPEN
PUT  /v1/documents/{id}       {items:[...], payments:[...]}
```

The device runs its own payment interface and answers when the customer has
finished — so the PUT is long, and there is no polling endpoint because there
is nothing to poll.

Money travels as **strings**: `"190.00"`, `"22.50"`. Not decimals, not floats.
The money layer was already BigInt-on-strings, so this is the one place it
becomes the wire format and nothing had to change to accommodate it.

Payment types are the documented set — `CASH`, `EFT_POS`, `CHECK`,
`VOUCHER_POS`, `VOUCHER`. A method that is not in that table is an error, never
a fallback to cash: sending CASH for a card payment puts the wrong tender on a
legal receipt and leaves the day-end short.

## The certificate, and why this is the important part

The device's certificate carries the **mali sicil no in its Subject instead of
a hostname**, so ordinary TLS verification cannot succeed. Hugin's own examples
use `curl -k`.

`-k` in a product means: accept whatever certificate answers on that address.
On a restaurant's wifi — the network with the guest laptop and the shared
tablet — that is an invitation to sit between the till and the fiscal device
and rewrite receipts.

So the trust is moved rather than dropped. Pairing records the certificate's
SHA-256 fingerprint; every later request demands the same certificate.
Different fingerprint, no request, and a message that says plainly which of the
two explanations applies. It is the SSH model: verified once, pinned
thereafter, loud when it changes.

Two things it deliberately does not do: it never touches
`NODE_TLS_REJECT_UNAUTHORIZED` (which would disable verification for the
licence check and the backup upload too), and it never silently re-pins.

**Two bugs found while testing this, both of which disarmed the check
silently:**

1. The check hung off the socket's `secureConnect` event. A pooled keep-alive
   socket is *already* secure, so the event never fired again — the pin was
   enforced on the first request of a connection and never after. A control
   that switches itself off after one use is worse than none, because it looks
   present.
2. With the TLS session cache on, every connection after the first **resumes**
   the session — and a resumed handshake does not re-send the certificate, so
   `getPeerCertificate()` came back empty and the pin was compared against
   nothing. Everything still looked fine: handshake fired, request succeeded.

Both are fixed (`keepAlive: false`, `maxCachedSessions: 0`, and the check now
also runs against the socket that actually carried the response). There is a
test for each, because neither failure was visible from the outside.

## What is deliberately not built

Cancellation, refund and X/Z reports **exist** in PC Link — the documentation
lists them under Banka İşlemleri and Raporlar — but their endpoints and
payloads are in the Postman API reference, which needs an integration account.
Those methods throw `ENDPOINT_UNDOCUMENTED` instead of guessing a path. A wrong
URL is a 404 and a bad afternoon; guessing at a Z-report endpoint is how a till
fires a day-end at a device in the middle of service.

## Cloud Link — the other protocol, and it is inverted

Worth knowing before anyone designs around it: in Cloud Link **the device is
the client and your server is the server.** It pulls open orders from *your*
webservice, takes payment on the device, and posts completed sales and Z
reports back to you. That is table-side and door payment.

It needs an endpoint published at something like
`https://pos.noktapp.com/hugin/v1`, an `X-ApiKey` per device, and the URL,
serial and key shared with Hugin. Nothing of it is built.

## What still blocks a real device

1. **The integration contract.** GİB's GMP regulation requires a signed
   agreement between the sales software and the manufacturer — "satış
   yazılımları ile üretici arasında entegrasyon sözleşmesi bulunmalıdır". The
   VKN on it is what gets typed into the device and sent as `X-SoftwareId`.
   No contract, no pairing. This is paperwork, not engineering.
2. **A test device.**
3. **The Postman API reference**, for the endpoints above.
4. **Capability evidence.** Even paired, the device cannot take money until
   `basketSale` is recorded as VERIFIED with an evidence reference, and
   `production_enabled` is switched on with the serial typed to confirm. Those
   gates already existed and the new adapter does not bypass them.

## Running the tests

```
NOKTAPP_DATA_DIR=/tmp/nokdata node pos-service/test/hugin.js
```

29 checks. The last group boots the service and drives the pairing endpoint
over HTTP, because pairing has to write the right row and a unit test of the
adapter alone would not notice if the route wrote none of it.
