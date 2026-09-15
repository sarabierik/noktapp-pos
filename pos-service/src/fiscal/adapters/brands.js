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

class HuginAdapter extends Gmp3Adapter {
  constructor(device, o = {}) {
    super(device, {
      defaultPort: 7500,
      fieldMap: { command: 'cmd', payload: 'params', sessionId: 'transactionId' },
      ...o,
    });
  }
  get name() { return 'hugin'; }
}

class ProfiloAdapter extends HuginAdapter {           // Profilo devices are Hugin firmware
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
