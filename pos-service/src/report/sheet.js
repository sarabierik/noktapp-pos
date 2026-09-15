'use strict';
/**
 * One table shape, three renderings.
 *
 * A "sheet" is `{ name, cols, rows }`, where every column declares its type.
 * The type is what makes an export readable in Turkey and it is declared once
 * here rather than guessed per renderer: the CSV, the workbook and the PDF all
 * read the same `t` and format the same value the same way.
 *
 * Turkish Excel is the reason the types exist at all:
 *
 *   - a UTF-8 BOM, or Excel decides the file is cp1254 and ç ğ ş ı come out as
 *     mojibake in the accountant's hands;
 *   - ';' as the separator, because a Turkish Windows locale uses the comma as
 *     the DECIMAL mark and a comma-separated file opens as one column;
 *   - '1234,56' for money, for the same reason;
 *   - '01.09.2026' for dates, because '2026-09-01' is read as text and a
 *     column of text cannot be sorted or subtotalled.
 *
 * Get any one of the four wrong and the accountant gets an unusable file and
 * rings the restaurant, not us.
 */
const MONEY = 'money', INT = 'int', PCT = 'pct', TXT = 'txt', DATE = 'date', DT = 'dt';

/** dd.mm.yyyy from an ISO date, a Date, or a MySQL datetime. */
function dmy(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const d = new Date(v);
  if (isNaN(d.getTime())) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** dd.mm.yyyy hh:mm - a timestamp keeps its clock, a bare date does not. */
function dmyTime(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dmy(s);
  const d = new Date(v);
  if (isNaN(d.getTime())) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${dmy(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Turkish money for a printed page: 1.234,56 - grouped, always two decimals. */
function tlText(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const [a, b] = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '-' : '') + a.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + b;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvNum(v, dp = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(dp).replace('.', ',');
}

/** A cell as the CSV wants it: comma decimals, dotted dates, plain text. */
function fmt(v, type) {
  if (type === MONEY) return csvNum(v, 2);
  if (type === PCT) return csvNum(v, 1);
  if (type === INT) return String(Math.round(Number(v) || 0));
  if (type === DATE) return dmy(v);
  if (type === DT) return dmyTime(v);
  return v === null || v === undefined ? '' : String(v);
}

/** The same cell as the PDF wants it: grouped money, right-aligned by type. */
function pdfCell(v, type) {
  if (type === MONEY) return tlText(v);
  if (type === PCT) return csvNum(v, 1);
  if (type === INT) return String(Math.round(Number(v) || 0));
  if (type === DATE) return dmy(v);
  if (type === DT) return dmyTime(v);
  return v === null || v === undefined ? '' : String(v);
}

const isNumeric = (t) => t === MONEY || t === PCT || t === INT;

/**
 * The column total, or null where a total would be a lie.
 *
 * Money and counts add up. A percentage does not - summing a margin column
 * gives a number with no meaning, and an accountant reading a "Marj % 1.284,0"
 * footer has been handed nonsense. So PCT gets no footer figure at all.
 */
function columnTotal(rows, col) {
  // `nosum` is for a number that is a NAME: adding up adisyon numbers gives
  // "155" under a column of four bills, which is worse than no total at all
  if (col.nosum) return null;
  if (col.t !== MONEY && col.t !== INT) return null;
  const n = rows.reduce((s, r) => s + (Number(r[col.k]) || 0), 0);
  return col.t === INT ? Math.round(n) : Math.round(n * 100) / 100;
}

function sheetCsv(sheet) {
  const out = [sheet.cols.map(c => csvCell(c.tr)).join(';')];
  for (const r of sheet.rows) out.push(sheet.cols.map(c => csvCell(fmt(r[c.k], c.t))).join(';'));
  /*
   * No TOPLAM footer row here, deliberately. A spreadsheet is a spreadsheet -
   * the accountant sorts it, filters it and pivots it, and a total row glued
   * to the bottom of the data joins in and corrupts every one of those. The
   * footer belongs on the PDF, which is a document and cannot be re-sorted.
   */
  return out.join('\r\n');
}

/** One or many sheets as a single Turkish-safe CSV. */
function toCsv(sheets) {
  const parts = [];
  for (const s of sheets) {
    if (sheets.length > 1) parts.push(csvCell(s.name));
    parts.push(sheetCsv(s));
    parts.push('');
  }
  return '﻿' + parts.join('\r\n') + '\r\n';
}

/** The same sheets as a real workbook, one tab each. */
async function toXlsx(sheets) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NOKTApp POS';
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    ws.columns = s.cols.map(c => ({
      header: c.tr, key: c.k, width: c.t === TXT ? Math.max(14, Math.min(34, c.tr.length + 10)) : 14,
    }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF7A1A' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of s.rows) {
      const o = {};
      for (const c of s.cols) {
        const v = r[c.k];
        // dates go in as the text Excel will read as a Turkish date, not as an
        // ISO string it would left-align and refuse to sort
        o[c.k] = isNumeric(c.t) ? Number(v) || 0 : fmt(v, c.t);
      }
      ws.addRow(o);
    }
    for (const c of s.cols) {
      const col = ws.getColumn(c.k);
      if (!col) continue;
      if (c.t === MONEY) col.numFmt = '#,##0.00';
      if (c.t === PCT) col.numFmt = '#,##0.0';
      if (isNumeric(c.t)) col.alignment = { horizontal: 'right' };
    }
  }
  return wb.xlsx.writeBuffer();
}

module.exports = {
  MONEY, INT, PCT, TXT, DATE, DT,
  dmy, dmyTime, tlText, csvCell, csvNum, fmt, pdfCell, isNumeric, columnTotal,
  sheetCsv, toCsv, toXlsx,
};
