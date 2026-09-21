'use strict';
/**
 * Brand adapters.
 *
 * Every Yeni Nesil ÖKC sold in Turkey speaks GMP-3, so each brand is the shared
 * GMP-3 client plus its own default port and field naming. When a customer's
 * device firmware uses different names, only the `fieldMap` below changes.
 */
const { Gmp3Adapter } = require('./gmp3');

class IngenicoAdapter extends Gmp3Adapter {
  /*
   * 4520, read off a working MOVE 5000F's settings screen. It was 7500 here,
   * which is a number I made up: a till shipped with that default could never
   * have reached an Ingenico at all.
   */
  constructor(device, o = {}) {
    super(device, { defaultPort: 4520, ...o });
  }
  get name() { return 'ingenico'; }
}

/*
 * HUGIN IS NO LONGER A GUESS.
 *
 * It used to be Gmp3Adapter on port 7500 with command names ('cmd', 'params',
 * 'transactionId') that I made up. Hugin publishes its protocol at
 * developer.hugin.com.tr and it is nothing like that: HTTPS REST on port 4443,
 * three identity headers, POST/PUT on /v1/documents, and no DLL at all. The
 * real client is in adapters/hugin.js and every field in it is quoted from
 * that documentation.
 */
const { HuginPcLinkAdapter } = require('./hugin');
const HuginAdapter = HuginPcLinkAdapter;

/*
 * Profilo is a SEPARATE QUESTION and stays where it was.
 *
 * The old comment here said "Profilo devices are Hugin firmware" and had
 * Profilo inherit Hugin's behaviour. That was an assumption, and now that
 * Hugin's adapter is real the assumption would have become a claim: that a
 * Profilo device answers PC Link on 4443. The documentation I have is Hugin's
 * and says nothing about Profilo. So Profilo keeps the unverified GMP-3 path,
 * which cannot reach a device until somebody sets wire_verified - the correct
 * state for a protocol nobody has confirmed.
 */
class ProfiloAdapter extends Gmp3Adapter {
  constructor(device, o = {}) { super(device, { defaultPort: 7500, ...o }); }
  get name() { return 'profilo'; }
}

class TokenAdapter extends Gmp3Adapter {              // Token / Verifone
  constructor(device, o = {}) {
    super(device, {
      defaultPort: 7600,
      fieldMap: { command: 'operation', payload: 'body', sessionId: 'refNo', receiptNo: 'fisNo', zNo: 'zNo' },
      ...o,
    });
  }
  get name() { return 'token'; }
}

class BekoAdapter extends TokenAdapter {              // Beko devices run Token firmware
  get name() { return 'beko'; }
}

class OlivettiAdapter extends Gmp3Adapter {
  constructor(device, o = {}) { super(device, { defaultPort: 7500, ...o }); }
  get name() { return 'olivetti'; }
}

module.exports = { IngenicoAdapter, HuginAdapter, ProfiloAdapter, TokenAdapter, BekoAdapter, OlivettiAdapter };
