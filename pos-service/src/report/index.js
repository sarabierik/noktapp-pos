'use strict';
/**
 * One place that turns a report pack into a downloaded file.
 *
 * Both export routes used to set their own headers, and only one of them got
 * them right. They also both used to be reachable with the session token on
 * the QUERY STRING, because a `window.open` cannot send an Authorization
 * header - which put a live bearer token into the browser history, into the
 * address bar, and into every proxy and access log between here and the
 * screen. The till now downloads with an authorised fetch and a Blob, so the
 * token stays in the header where it belongs and these routes only ever see
 * `Authorization: Bearer`.
 */
const sheet = require('./sheet');
const { reportPdf } = require('./pdf');

const TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/**
 * Send `pack` as csv, xlsx or pdf.
 *
 * `Content-Disposition: attachment` is what makes a browser save the file
 * instead of painting it into a tab - which is exactly what the old CSV button
 * appeared to do, because a window opened at a text/csv URL renders.
 */
async function deliver(res, clientId, pack, { format = 'csv', producedBy = '' } = {}) {
  const f = String(format || 'csv').toLowerCase();
  const ext = TYPES[f] ? f : 'csv';
  let body;
  if (ext === 'pdf') body = await reportPdf(clientId, { ...pack, producedBy });
  else if (ext === 'xlsx') body = Buffer.from(await sheet.toXlsx(pack.sheets));
  else body = Buffer.from(sheet.toCsv(pack.sheets), 'utf8');

  res.setHeader('Content-Type', TYPES[ext]);
  res.setHeader('Content-Disposition', `attachment; filename="${pack.name}.${ext}"`);
  res.setHeader('Content-Length', String(body.length));
  // the figures are as of now; a proxy or a browser cache serving yesterday's
  // export to an accountant is worse than a slow one
  res.setHeader('Cache-Control', 'no-store');
  return res.send(body);
}

module.exports = { deliver };
