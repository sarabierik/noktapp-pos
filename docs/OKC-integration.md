# ÖKC (Yeni Nesil Ödeme Kaydedici Cihaz)

## How it is wired

The till never talks to a device directly. It calls the fiscal module, which
picks an adapter based on what you configured for that cash register:

```
till  →  fiscal module  →  adapter  →  device (TCP)
                        ↘  simulator (no hardware)
```

The plumbing is complete and tested end to end: the bill is locked so two
cashiers cannot start two device sales on it, a `fiscal_transactions` row
follows the sale through `created → waiting_device → approved / declined`, the
fiscal receipt number, Z number, EKÜ serial, approval code and masked card are
stored in `fiscal_receipts`, and on approval the payment is written onto the
bill, which closes itself if nothing is left to pay. All of that uses the
`fiscal_*` tables that were already in your dump.

## The adapters

Every Yeni Nesil ÖKC sold in Turkey speaks GİB's GMP-3 over a local TCP socket:
a 4-byte big-endian length, then a JSON body. So there is one client
(`src/fiscal/adapters/gmp3.js`) holding the transport, framing, retries and the
state machine, and each brand is a thin subclass that changes two things: the
default port and a handful of field names.

| Adapter | Default port | Notes |
|---|---|---|
| `simulator` | — | Software device. Same states, same receipt fields, no hardware. Start here. |
| `ingenico` | 7500 | Ingenico / Ingenico-TSM |
| `hugin` | 7500 | Field names `cmd` / `params` / `transactionId` |
| `profilo` | 7500 | Profilo units run Hugin firmware |
| `token` | 7600 | Token / Verifone; `operation` / `body` / `refNo`, receipt field `fisNo` |
| `beko` | 7600 | Beko units run Token firmware |
| `olivetti` | 7500 | |

## What still needs your input

Each manufacturer issues an integration document with the exact field names for
their firmware revision, and hands out test credentials. When you get those, the
**only** thing to change is the `fieldMap` in `src/fiscal/adapters/brands.js` —
one object per brand. Nothing in the till, the payment flow, the receipt storage
or the reports has to be touched.

Because of that, do the first real-device test on a device you can afford to
have refuse a sale. **Do not point it at the ÖKC in your own restaurant** until
one adapter is confirmed against a test unit; the simulator covers staff
training and demos completely.

## Trying it now

1. Ayarlar → ÖKC → Cihaz ekle → marka `simulator`.
2. Open a bill, press Öde, then "ÖKC ile öde (mali fiş)".
3. The device screen appears, answers in about a second and a half, and the
   fiscal receipt number lands on the bill.
4. Any transaction whose id ends in 9 is refused on purpose, so you can rehearse
   what a declined card looks like.

## Refunds and reports

`fiscal.refund()` and `fiscal.deviceReport('X' | 'Z')` are implemented and
stored in `fiscal_refunds` and `fiscal_device_reports`. The device's own Z
report is separate from the program's Z report — the program's is the management
figure, the device's is the fiscal one.
