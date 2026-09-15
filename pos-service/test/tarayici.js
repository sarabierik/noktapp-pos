'use strict';
//
// Where Chromium lives depends on the machine.
//
// These suites were written in a sandbox that keeps a browser at
// /opt/pw-browsers, and every one of them hard-coded that path. It is the
// right path on exactly one computer. On a GitHub runner - or on any laptop
// where someone runs `npx playwright install` - the browser is somewhere else
// entirely, and the suite dies before its first assertion with
// "executable doesn't exist", which says nothing about the code under test.
//
// So: look for a browser in the places it is known to live, and if none of
// them is there, say nothing and let Playwright find its own. Leaving
// executablePath off is not a fallback that might work - it is Playwright's
// normal way of working, and the one that is right on a machine we have never
// seen.
//
const fs = require('fs');
const { chromium } = require('playwright');

const ADAYLAR = [
  process.env.PW_CHROME,              // an explicit override always wins
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium',        // the sandbox
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter(Boolean);

let cozuldu;

/** Absolute path to a Chromium binary, or null to let Playwright decide. */
function chromeYolu() {
  if (cozuldu !== undefined) return cozuldu;
  cozuldu = null;
  for (const yol of ADAYLAR) {
    try {
      if (fs.statSync(yol).isFile()) { cozuldu = yol; break; }
    } catch { /* bu aday yok, sıradakine bak */ }
  }
  return cozuldu;
}

/**
 * Launch Chromium the same way on every machine.
 * --no-sandbox is required inside containers (CI runners included) and is
 * harmless on a desktop; --disable-dev-shm-usage stops the 64MB /dev/shm on a
 * default Docker image from crashing a page mid-screenshot.
 */
async function tarayiciAc(extra = {}) {
  const { args: fazladanArgs = [], ...kalan } = extra;
  const opts = {
    ...kalan,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...fazladanArgs],
  };
  const yol = chromeYolu();
  if (yol) opts.executablePath = yol;
  return chromium.launch(opts);
}

module.exports = { chromeYolu, tarayiciAc };
