'use strict';
/**
 * Minimal ESC/POS writer. Kept in-house on purpose: thermal printers in Turkish
 * restaurants are a mixed bag and we only need a small, predictable subset.
 * Turkish characters are emitted in code page 857 (PC857 - Turkish), which every
 * common 80mm printer supports.
 */
const ESC = 0x1b, GS = 0x1d;

const CP857 = {
  'ç': 0x87, 'Ç': 0x80, 'ğ': 0xa6, 'Ğ': 0xa7, 'ı': 0x8d, 'İ': 0x98,
  'ö': 0x94, 'Ö': 0x99, 'ş': 0x9e, 'Ş': 0x9f, 'ü': 0x81, 'Ü': 0x9a,
  '₺': 0x54, '“': 0x22, '”': 0x22, '’': 0x27, '–': 0x2d, '—': 0x2d,
};

function encode(text) {
  const out = [];
  for (const ch of String(text)) {
    if (CP857[ch] !== undefined) out.push(CP857[ch]);
    else {
      const c = ch.charCodeAt(0);
      out.push(c < 128 ? c : 0x3f); // '?' for anything the printer cannot show
    }
  }
  return Buffer.from(out);
}

/*
 * The inverse of encode(), added for the receipt PREVIEW.
 *
 * The Fis ayarlari screen has to show the owner what will actually come out of
 * the printer, and the only honest way to do that is to decode the bytes the
 * printer will be sent rather than to build a second, parallel renderer that
 * can drift from this one. So: the same code page, read backwards.
 */
const FROM_CP857 = {};
for (const [ch, code] of Object.entries(CP857)) {
  // only the real high-range letters invert: the table also folds '₺' onto 'T'
  // and the typographic quotes onto ASCII, and those must decode as themselves.
  if (code >= 0x80 && FROM_CP857[code] === undefined) FROM_CP857[code] = ch;
}

/**
 * Turn an ESC/POS buffer back into the lines it will print.
 *
 * Returns [{ text, bold, dw, align }] - `dw` is double width, which occupies
 * two character cells per letter, so a preview must render it at twice the
 * width or it will lie about how much paper the line takes.
 *
 * Only the commands this file emits are understood; anything else is skipped
 * by its documented length so an unknown sequence cannot leak into the text.
 */
function decode(buf) {
  const lines = [];
  let cur = '', bold = false, dw = false, align = 'left', qrData = '';
  let lb = false, ldw = false, lal = 'left';        // attributes of the line in hand
  const push = () => { lines.push({ text: cur, bold: lb, dw: ldw, align: lal }); cur = ''; lb = bold; ldw = dw; lal = align; };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === ESC) {
      const c = buf[i + 1];
      if (c === 0x40) { i += 1; continue; }                       // init
      if (c === 0x45) { bold = !!buf[i + 2]; if (!cur) lb = bold; i += 2; continue; }
      if (c === 0x61) { align = ['left', 'center', 'right'][buf[i + 2]] || 'left'; if (!cur) lal = align; i += 2; continue; }
      if (c === 0x64) { for (let n = buf[i + 2]; n > 0; n--) push(); i += 2; continue; }
      if (c === 0x70) { i += 4; continue; }                       // drawer pulse
      i += 2; continue;                                           // ESC t n, ESC - n
    }
    if (b === GS) {
      const c = buf[i + 1];
      if (c === 0x21) { dw = buf[i + 2] !== 0; if (!cur) ldw = dw; i += 2; continue; }
      if (c === 0x56) { i += 3; continue; }                       // cut
      /*
       * GS ( k - the QR commands. Skipped by length, as every unknown sequence
       * is, but not silently: the printer draws a square here, and a preview
       * that showed the caption with nothing above it would tell the owner his
       * karekod is not working. So the two commands that matter are read - the
       * one that stores the payload and the one that prints it - and the
       * square becomes one marker line carrying the address it will scan to.
       * That is the honest rendering: the preview cannot draw a QR at 13px of
       * monospace, but it can say what is there and what is in it.
       */
      if (c === 0x28) {
        const len = buf[i + 3] + buf[i + 4] * 256;
        const cn = buf[i + 5], fn = buf[i + 6];
        if (buf[i + 2] === 0x6b && cn === 0x31 && fn === 0x50) {
          qrData = buf.slice(i + 8, i + 5 + len).toString('utf8');
        } else if (buf[i + 2] === 0x6b && cn === 0x31 && fn === 0x51) {
          if (cur) push();
          lines.push({ text: '[karekod] ' + qrData, bold: false, dw: false, align: 'center', qr: qrData });
        }
        i += 4 + len; continue;
      }
      i += 2; continue;
    }
    if (b === 0x0a) { push(); continue; }
    if (b === 0x0d) continue;
    if (!cur) { lb = bold; ldw = dw; lal = align; }
    cur += FROM_CP857[b] !== undefined ? FROM_CP857[b] : String.fromCharCode(b);
  }
  if (cur) push();
  return lines;
}

class Receipt {
  constructor(width = 48) {
    this.width = width;
    this.dw = false;      // double width halves how many characters fit
    this.parts = [];
    this.raw(Buffer.from([ESC, 0x40]));            // initialise
    this.raw(Buffer.from([ESC, 0x74, 0x0d]));      // code page 857
  }
  raw(buf) { this.parts.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); return this; }
  text(s = '') { this.raw(encode(s)); return this; }
  line(s = '') { return this.text(s).raw(Buffer.from([0x0a])); }
  feed(n = 1) { return this.raw(Buffer.from([ESC, 0x64, n])); }
  align(a) { return this.raw(Buffer.from([ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0])); }
  bold(on) { return this.raw(Buffer.from([ESC, 0x45, on ? 1 : 0])); }
  /* Double width is not decoration: it halves the number of characters that
     fit on the paper, so cols()/item()/rule() below must know about it. The
     TOPLAM line was emitted double width across the full 48 columns, which is
     96 columns of paper - the printer wrapped it and the amount landed on a
     line of its own. */
  double(on) { this.dw = !!on; return this.raw(Buffer.from([GS, 0x21, on ? 0x11 : 0x00])); }
  /** Characters that fit on one line right now. */
  cells() { return this.dw ? Math.floor(this.width / 2) : this.width; }
  underline(on) { return this.raw(Buffer.from([ESC, 0x2d, on ? 1 : 0])); }
  rule(ch = '-') { return this.line(ch.repeat(this.cells())); }
  /** left text + right text on the same line, padded to the paper width. */
  cols(left, right) {
    const l = String(left), r = String(right);
    const pad = Math.max(1, this.cells() - l.length - r.length);
    return this.line(l + ' '.repeat(pad) + r);
  }
  /** three columns: qty, name, amount */
  item(qty, name, amount) {
    const q = String(qty).padEnd(4);
    const a = String(amount).padStart(10);
    const room = this.cells() - q.length - a.length;
    let n = String(name);
    const first = n.slice(0, room);
    this.line(q + first.padEnd(room) + a);
    n = n.slice(room);
    while (n.length) { this.line(' '.repeat(4) + n.slice(0, room)); n = n.slice(room); }
    return this;
  }
  center(s) { return this.align('center').line(s).align('left'); }
  cut() { return this.feed(4).raw(Buffer.from([GS, 0x56, 0x42, 0x00])); }
  drawer() { return this.raw(Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa])); }
  /**
   * A native QR symbol: GS ( k, model 2.
   *
   * The payload was encoded as 'ascii', which in Node masks every byte to 7
   * bits - so a QR carrying "Menü" or a Turkish domain did not fail, it
   * silently encoded different characters and scanned to gibberish. QR is a
   * byte-mode symbol and every phone camera decodes it as UTF-8, so the bytes
   * go in as UTF-8 and mean what they say. Nothing that is pure ASCII changes.
   */
  qr(data) {
    const d = Buffer.from(String(data), 'utf8');
    const len = d.length + 3;
    return this
      .raw(Buffer.from([GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00]))
      .raw(Buffer.from([GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 6]))
      .raw(Buffer.from([GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31]))
      .raw(Buffer.from([GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30]))
      .raw(d)
      .raw(Buffer.from([GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30]));
  }
  build() { return Buffer.concat(this.parts); }
}

module.exports = { Receipt, encode, decode };
