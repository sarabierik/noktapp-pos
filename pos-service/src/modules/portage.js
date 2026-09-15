'use strict';
/**
 * Import and export of the menu: categories and products.
 *
 * A restaurant that already has a price list does not want to retype 300
 * products into a till, and one that changes its prices for the season wants
 * to do it in Excel with the whole list in front of it, not one dialog at a
 * time. So both directions, in both formats a restaurant actually has: CSV
 * (what every other POS exports) and XLSX (what the owner actually opens).
 *
 * Two rules make the round trip safe:
 *
 *   1. Export writes the row's `id`. Import treats a row WITH an id as an
 *      update and a row WITHOUT one as a new record, so export -> edit ->
 *      import changes the menu instead of duplicating it.
 *   2. Import is previewed before it is applied. A menu is the thing the whole
 *      till is built on; overwriting it from a spreadsheet no one checked is
 *      how a restaurant opens on Friday with the wrong prices.
 */
const ExcelJS = require('exceljs');
const db = require('./../db');
const _catalog = require('./catalog');
const log = require('../logger');
const { money } = require('../util/http');

/* ---------------------------- column maps -------------------------- */
/*
 * Turkish headers, because the person editing the file is Turkish. English
 * aliases are accepted on the way in so a file exported from another POS
 * usually just works.
 */
const PRODUCT_COLUMNS = [
  { key: 'id', tr: 'ID', aliases: ['id', 'urun_id', 'product_id'] },
  { key: 'category', tr: 'Kategori', aliases: ['kategori', 'category', 'category_name', 'grup'] },
  { key: 'name', tr: 'Urun Adi', aliases: ['urun adi', 'urun_adi', 'urun', 'ad', 'name', 'product', 'product_name', 'aciklama_adi'] },
  { key: 'price', tr: 'Fiyat', aliases: ['fiyat', 'price', 'satis fiyati', 'satis_fiyati', 'birim fiyat'] },
  { key: 'cost_price', tr: 'Maliyet', aliases: ['maliyet', 'cost', 'cost_price', 'alis fiyati'] },
  { key: 'vat_rate', tr: 'KDV %', aliases: ['kdv', 'kdv %', 'kdv orani', 'kdv_orani', 'vat', 'vat_rate'] },
  { key: 'sort_order', tr: 'Sira', aliases: ['sira', 'sort', 'sort_order', 'siralama'] },
  { key: 'track_stock', tr: 'Stok Takibi', aliases: ['stok takibi', 'stok_takibi', 'track_stock', 'stok'] },
  { key: 'use_in_pos', tr: 'Kasada', aliases: ['kasada', 'use_in_pos', 'pos'] },
  { key: 'use_in_qr', tr: 'QR Menude', aliases: ['qr menude', 'use_in_qr', 'qr'] },
  { key: 'is_active', tr: 'Aktif', aliases: ['aktif', 'is_active', 'active', 'durum'] },
  { key: 'description', tr: 'Aciklama', aliases: ['aciklama', 'description', 'not'] },
];

const CATEGORY_COLUMNS = [
  { key: 'id', tr: 'ID', aliases: ['id', 'kategori_id', 'category_id'] },
  { key: 'name', tr: 'Kategori Adi', aliases: ['kategori adi', 'kategori_adi', 'kategori', 'ad', 'name', 'category'] },
  { key: 'station', tr: 'Istasyon', aliases: ['istasyon', 'station', 'mutfak', 'yazici'] },
  { key: 'sort_order', tr: 'Sira', aliases: ['sira', 'sort', 'sort_order'] },
  { key: 'use_in_pos', tr: 'Kasada', aliases: ['kasada', 'use_in_pos', 'pos'] },
  { key: 'use_in_qr', tr: 'QR Menude', aliases: ['qr menude', 'use_in_qr', 'qr'] },
  { key: 'is_active', tr: 'Aktif', aliases: ['aktif', 'is_active', 'active'] },
];

const SPECS = { products: PRODUCT_COLUMNS, categories: CATEGORY_COLUMNS };

/* ------------------------------ parsing ---------------------------- */

/** Fold a header cell down to something we can match: lower case, no accents. */
function normaliseHeader(h) {
  return String(h == null ? '' : h)
    .replace(/İ/g, 'i').replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[şŞ]/g, 's').replace(/[ğĞ]/g, 'g').replace(/[üÜ]/g, 'u')
    .replace(/[öÖ]/g, 'o').replace(/[çÇ]/g, 'c')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Turkish money as typed by a Turkish person.
 *
 * "1.250,50" is one thousand two hundred fifty and a half; "1,250.50" is the
 * same number typed by a machine. Both separators present means the RIGHTMOST
 * is the decimal point. A lone comma is always the decimal point.
 *
 * A lone dot is the hard case, and a spreadsheet is not a keypad. "12.50" is a
 * price; "1.250" is one thousand two hundred fifty, because nobody writes a
 * price to three decimals. So: a single dot with exactly three digits after it
 * is a thousands separator, anything else is a decimal point. Get this wrong
 * and a 1.250 TL bottle of wine is imported at 1,25.
 */
function parseNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/\s/g, '').replace(/[₺$€]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousand = decimal === ',' ? '.' : ',';
    s = s.split(thousand).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    s = s.replace(/,/g, '.');
  } else if (lastDot >= 0) {
    const dots = (s.match(/\./g) || []).length;
    const tail = s.length - lastDot - 1;
    if (dots > 1 || tail === 3) s = s.split('.').join('');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Yes/no as a Turkish person writes it. Anything unrecognised is null. */
function parseBool(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = normaliseHeader(v);
  if (['1', 'evet', 'e', 'var', 'aktif', 'true', 'yes', 'y', 'acik'].includes(s)) return true;
  if (['0', 'hayir', 'h', 'yok', 'pasif', 'false', 'no', 'n', 'kapali'].includes(s)) return false;
  return null;
}

/**
 * A CSV parser that survives real files: quoted fields, embedded commas and
 * newlines, doubled quotes, and both separators - Turkish Excel writes
 * semicolons because the comma is the decimal point.
 */
function parseCsv(text) {
  let s = String(text).replace(/^﻿/, '');
  const head = s.slice(0, s.indexOf('\n') === -1 ? s.length : s.indexOf('\n'));
  // pick the delimiter by counting outside quotes on the header line
  const sep = (head.split(';').length > head.split(',').length) ? ';' : ',';

  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/*
 * Money in a CSV goes out with a comma, because the file is opened in a
 * Turkish Excel where the comma IS the decimal separator. Writing "120.00"
 * there gives you a cell reading 120,00 only by luck, and 12000 the rest of
 * the time. XLSX is unaffected: those cells carry real numbers.
 */
function csvMoney(v) {
  return money(v).toFixed(2).replace('.', ',');
}

/* ------------------------------ export ----------------------------- */

async function exportRows(clientId, kind) {
  if (kind === 'categories') {
    const rows = await db.query(
      `SELECT c.id, c.name, s.name AS station, c.sort_order, c.use_in_pos, c.use_in_qr, c.is_active
         FROM categories c
         LEFT JOIN stations s ON s.id = c.station_id AND s.client_id = c.client_id
        WHERE c.client_id=? ORDER BY c.sort_order, c.name`, [clientId]);
    return rows.map(r => ({
      id: r.id, name: r.name, station: r.station || '',
      sort_order: r.sort_order, use_in_pos: r.use_in_pos ? 1 : 0,
      use_in_qr: r.use_in_qr ? 1 : 0, is_active: r.is_active ? 1 : 0,
    }));
  }
  const rows = await db.query(
    `SELECT p.id, c.name AS category, p.name, p.price, p.cost_price, p.vat_rate,
            p.sort_order, p.track_stock, p.use_in_pos, p.use_in_qr, p.is_active, p.description
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id AND c.client_id = p.client_id
      WHERE p.client_id=? ORDER BY c.sort_order, c.name, p.sort_order, p.name`, [clientId]);
  return rows.map(r => ({
    id: r.id, category: r.category || '', name: r.name,
    price: money(r.price), cost_price: money(r.cost_price || 0),
    vat_rate: Number(r.vat_rate || 0),
    sort_order: r.sort_order, track_stock: r.track_stock ? 1 : 0,
    use_in_pos: r.use_in_pos ? 1 : 0, use_in_qr: r.use_in_qr ? 1 : 0,
    is_active: r.is_active ? 1 : 0, description: r.description || '',
  }));
}

async function exportCsv(clientId, kind) {
  const spec = SPECS[kind];
  const rows = await exportRows(clientId, kind);
  /*
   * Semicolons and a BOM. Turkish Excel uses the comma as a decimal separator,
   * so a comma-separated file opens with every row crammed into column A - and
   * without the BOM the Turkish characters arrive as mojibake.
   */
  const isMoney = (k) => k === 'price' || k === 'cost_price';
  const out = [spec.map(c => csvCell(c.tr)).join(';')];
  for (const r of rows) {
    out.push(spec.map(c => csvCell(isMoney(c.key) ? csvMoney(r[c.key]) : r[c.key])).join(';'));
  }
  return '﻿' + out.join('\r\n') + '\r\n';
}

async function exportXlsx(clientId, kind) {
  const spec = SPECS[kind];
  const rows = await exportRows(clientId, kind);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NOKTApp POS';
  const ws = wb.addWorksheet(kind === 'categories' ? 'Kategoriler' : 'Urunler');
  ws.columns = spec.map(c => ({
    header: c.tr, key: c.key,
    width: c.key === 'name' || c.key === 'description' ? 34 : c.key === 'category' ? 22 : 12,
  }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF7A1A' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(r);
  for (const key of ['price', 'cost_price']) {
    const col = ws.getColumn(key);
    if (col) col.numFmt = '#,##0.00';
  }
  // the id column is the round trip: hide it rather than invite editing
  const idCol = ws.getColumn('id');
  if (idCol) { idCol.width = 8; idCol.font = { color: { argb: 'FF9A9AA2' } }; }
  return wb.xlsx.writeBuffer();
}

/* ------------------------------ import ----------------------------- */

/** Turn a file into rows of {key: value}, whatever it arrived as. */
async function readFile(kind, buffer, filename = '') {
  const spec = SPECS[kind];
  let matrix;
  if (/\.xlsx?$/i.test(filename) || (buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) { const e = new Error('Dosyada sayfa yok'); e.status = 400; throw e; }
    matrix = [];
    ws.eachRow((row) => {
      const vals = [];
      // values is 1-based and sparse; walk the declared width so blanks hold
      // their column position instead of shifting everything left
      for (let i = 1; i <= ws.columnCount; i++) {
        let v = row.getCell(i).value;
        if (v && typeof v === 'object') v = v.text != null ? v.text : (v.result != null ? v.result : '');
        vals.push(v == null ? '' : v);
      }
      matrix.push(vals);
    });
  } else {
    matrix = parseCsv(buffer.toString('utf8'));
  }
  if (!matrix.length) { const e = new Error('Dosya bos'); e.status = 400; throw e; }

  const header = matrix[0].map(normaliseHeader);
  const index = {};
  for (const col of spec) {
    const want = [normaliseHeader(col.tr), ...col.aliases.map(normaliseHeader)];
    const at = header.findIndex(h => h && want.includes(h));
    if (at >= 0) index[col.key] = at;
  }
  if (index.name == null) {
    const e = new Error(
      'Ad sutunu bulunamadi. Basliklar: ' + spec.map(c => c.tr).join(', '));
    e.status = 400;
    throw e;
  }
  return matrix.slice(1).map(cells => {
    const o = {};
    for (const [key, at] of Object.entries(index)) o[key] = cells[at];
    return o;
  });
}

/**
 * Work out what an import would do, without doing it.
 *
 * Returns one entry per row with an action (create / update / skip / error)
 * and the reason, so the screen can show the owner the damage before they
 * agree to it.
 */
async function planImport(clientId, kind, rows) {
  const cats = await db.query('SELECT id, name FROM categories WHERE client_id=?', [clientId]);
  const catByName = new Map(cats.map(c => [normaliseHeader(c.name), c]));
  const catById = new Map(cats.map(c => [Number(c.id), c]));
  const stations = await db.query('SELECT id, name FROM stations WHERE client_id=?', [clientId]);
  const stationByName = new Map(stations.map(s => [normaliseHeader(s.name), s]));

  const existing = kind === 'categories'
    ? cats
    : await db.query('SELECT id, name, category_id FROM products WHERE client_id=?', [clientId]);
  const byId = new Map(existing.map(r => [Number(r.id), r]));
  const byName = new Map(existing.map(r => [normaliseHeader(r.name), r]));

  const plan = [];
  const seen = new Set();
  let line = 1;
  for (const raw of rows) {
    line++;
    const name = String(raw.name == null ? '' : raw.name).trim();
    const entry = { line, name, action: 'create', errors: [], warnings: [], data: {} };

    if (!name) { entry.action = 'skip'; entry.errors.push('Ad bos'); plan.push(entry); continue; }

    const key = normaliseHeader(name);
    if (seen.has(key)) {
      entry.action = 'skip';
      entry.errors.push('Dosyada bu ad iki kez var');
      plan.push(entry); continue;
    }
    seen.add(key);

    /*
     * Identity: an explicit id wins; otherwise match on the name. Matching on
     * the name is what makes a hand-written price list update the existing
     * menu instead of doubling it - which is the mistake that actually
     * happens.
     */
    const id = raw.id ? Number(parseNumber(raw.id)) : null;
    let target = null;
    if (id && byId.has(id)) target = byId.get(id);
    else if (id && !byId.has(id)) entry.warnings.push(`ID ${id} bulunamadi, ad ile eslendi`);
    if (!target && byName.has(key)) target = byName.get(key);
    if (target) { entry.action = 'update'; entry.id = Number(target.id); }

    if (kind === 'categories') {
      entry.data.name = name;
      const stName = String(raw.station || '').trim();
      if (stName) {
        const st = stationByName.get(normaliseHeader(stName));
        if (st) entry.data.station_id = st.id;
        else entry.warnings.push(`Istasyon "${stName}" yok, bos birakildi`);
      }
      entry.data.sort_order = parseNumber(raw.sort_order) || 0;
      const pos = parseBool(raw.use_in_pos), qr = parseBool(raw.use_in_qr), act = parseBool(raw.is_active);
      entry.data.use_in_pos = pos == null ? true : pos;
      entry.data.use_in_qr = qr == null ? false : qr;
      entry.data.is_active = act == null ? true : act;
    } else {
      const catName = String(raw.category || '').trim();
      let cat = catName ? catByName.get(normaliseHeader(catName)) : null;
      if (!cat && target && target.category_id) cat = catById.get(Number(target.category_id));
      if (!cat && catName) {
        // creating the category is almost always what was meant; say so rather
        // than rejecting a whole price list over a category that is one row away
        entry.warnings.push(`Kategori "${catName}" olusturulacak`);
        entry.data.new_category = catName;
      } else if (!cat) {
        entry.action = 'skip';
        entry.errors.push('Kategori bos');
        plan.push(entry); continue;
      }
      if (cat) entry.data.category_id = cat.id;

      const price = parseNumber(raw.price);
      if (price == null && entry.action === 'create') {
        entry.action = 'skip';
        entry.errors.push('Fiyat okunamadi');
        plan.push(entry); continue;
      }
      if (price != null && price < 0) {
        entry.action = 'skip';
        entry.errors.push('Fiyat eksi olamaz');
        plan.push(entry); continue;
      }
      entry.data.name = name;
      if (price != null) entry.data.price = money(price);
      const cost = parseNumber(raw.cost_price);
      if (cost != null) entry.data.cost_price = money(cost);
      const vat = parseNumber(raw.vat_rate);
      if (vat != null) {
        // a rate written as 0,10 means 10%, not a tenth of a percent
        entry.data.vat_rate = vat > 0 && vat < 1 ? Math.round(vat * 100) : vat;
      }
      entry.data.sort_order = parseNumber(raw.sort_order) || 0;
      if (raw.description != null) entry.data.description = String(raw.description).trim() || null;
      const ts = parseBool(raw.track_stock), pos = parseBool(raw.use_in_pos);
      const qr = parseBool(raw.use_in_qr), act = parseBool(raw.is_active);
      entry.data.track_stock = ts == null ? false : ts;
      entry.data.use_in_pos = pos == null ? true : pos;
      entry.data.use_in_qr = qr == null ? false : qr;
      entry.data.is_active = act == null ? true : act;

      if (entry.action === 'update' && entry.data.price != null) {
        const cur = await db.one('SELECT price FROM products WHERE id=? AND client_id=?',
          [entry.id, clientId]);
        if (cur && money(cur.price) !== entry.data.price) {
          entry.warnings.push(`Fiyat ${money(cur.price)} -> ${entry.data.price}`);
        }
      }
    }
    plan.push(entry);
  }

  const summary = {
    total: plan.length,
    create: plan.filter(p => p.action === 'create').length,
    update: plan.filter(p => p.action === 'update').length,
    skip: plan.filter(p => p.action === 'skip').length,
  };
  return { plan, summary };
}

/**
 * Apply a plan.
 *
 * One transaction: a menu half-imported because row 180 had a bad price is
 * worse than one not imported at all, because nobody can tell by looking which
 * half is new.
 */
async function applyImport(clientId, kind, plan, userId) {
  const result = { created: 0, updated: 0, skipped: 0, categoriesCreated: 0, errors: [] };
  await db.tx(async (t) => {
    const newCats = new Map();
    for (const entry of plan) {
      if (entry.action === 'skip') { result.skipped++; continue; }
      const data = { ...entry.data };

      if (data.new_category) {
        const nk = normaliseHeader(data.new_category);
        if (newCats.has(nk)) data.category_id = newCats.get(nk);
        else {
          const id = await t.insert(
            'INSERT INTO categories (client_id, name, sort_order, is_active, use_in_pos, use_in_qr) VALUES (?,?,?,1,1,0)',
            [clientId, data.new_category, 0]);
          newCats.set(nk, id);
          data.category_id = id;
          result.categoriesCreated++;
        }
        delete data.new_category;
      }

      if (kind === 'categories') {
        if (entry.action === 'update') {
          await t.exec(
            `UPDATE categories SET name=?, station_id=?, sort_order=?, is_active=?, use_in_pos=?, use_in_qr=?
              WHERE id=? AND client_id=?`,
            [data.name, data.station_id || null, data.sort_order, data.is_active ? 1 : 0,
             data.use_in_pos ? 1 : 0, data.use_in_qr ? 1 : 0, entry.id, clientId]);
          result.updated++;
        } else {
          await t.insert(
            `INSERT INTO categories (client_id, name, station_id, sort_order, is_active, use_in_pos, use_in_qr)
             VALUES (?,?,?,?,?,?,?)`,
            [clientId, data.name, data.station_id || null, data.sort_order,
             data.is_active ? 1 : 0, data.use_in_pos ? 1 : 0, data.use_in_qr ? 1 : 0]);
          result.created++;
        }
        continue;
      }

      if (entry.action === 'update') {
        /*
         * Only the columns the file actually carried are written. A file with
         * just Ad and Fiyat is a price update, and it must not silently blank
         * every description and flag in the menu.
         */
        const sets = [], vals = [];
        const put = (col, v) => { sets.push(`${col}=?`); vals.push(v); };
        if (data.category_id) put('category_id', data.category_id);
        put('name', data.name);
        if (data.price != null) put('price', data.price);
        if (data.cost_price != null) put('cost_price', data.cost_price);
        if (data.vat_rate != null) put('vat_rate', data.vat_rate);
        if (data.description !== undefined) put('description', data.description);
        put('sort_order', data.sort_order);
        put('track_stock', data.track_stock ? 1 : 0);
        put('use_in_pos', data.use_in_pos ? 1 : 0);
        put('use_in_qr', data.use_in_qr ? 1 : 0);
        put('is_active', data.is_active ? 1 : 0);
        vals.push(entry.id, clientId);
        const before = await t.one('SELECT price FROM products WHERE id=? AND client_id=?', [entry.id, clientId]);
        await t.exec(`UPDATE products SET ${sets.join(', ')} WHERE id=? AND client_id=?`, vals);
        if (before && data.price != null && money(before.price) !== data.price) {
          // the price history is what the pricing report reads; an import that
          // skipped it would leave a silent step in every margin chart
          await t.exec(
            `INSERT INTO price_change_log (client_id, product_id, old_price, new_price, source, changed_by, changed_at)
             VALUES (?,?,?,?,'import',?,NOW())`,
            [clientId, entry.id, before.price, data.price, userId || 0]).catch(e =>
              log.warn('portage', 'price change log not written: ' + e.message));
        }
        result.updated++;
      } else {
        await t.insert(
          `INSERT INTO products (client_id, category_id, name, price, cost_price, description,
              sort_order, is_active, use_in_pos, use_in_qr, vat_rate, track_stock)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [clientId, data.category_id, data.name, data.price || 0, data.cost_price || 0,
           data.description || null, data.sort_order,
           data.is_active ? 1 : 0, data.use_in_pos ? 1 : 0, data.use_in_qr ? 1 : 0,
           data.vat_rate || 0, data.track_stock ? 1 : 0]);
        result.created++;
      }
    }
  });
  log.info('portage', `${kind} import: +${result.created} ~${result.updated} -${result.skipped}`);
  return result;
}

/** A blank file with the right headers and one example row. */
async function template(kind, format) {
  const spec = SPECS[kind];
  const example = kind === 'categories'
    ? { id: '', name: 'Baslangiclar', station: 'Mutfak', sort_order: 1, use_in_pos: 1, use_in_qr: 1, is_active: 1 }
    : { id: '', category: 'Baslangiclar', name: 'Mercimek Corbasi', price: '95,00', cost_price: '28,00',
        vat_rate: 10, sort_order: 1, track_stock: 0, use_in_pos: 1, use_in_qr: 1,
        is_active: 1, description: '' };
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(kind === 'categories' ? 'Kategoriler' : 'Urunler');
    ws.columns = spec.map(c => ({ header: c.tr, key: c.key, width: c.key === 'name' ? 34 : 14 }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF7A1A' } };
    ws.addRow(example);
    return wb.xlsx.writeBuffer();
  }
  return '﻿' + [spec.map(c => csvCell(c.tr)).join(';'),
                     spec.map(c => csvCell(example[c.key])).join(';')].join('\r\n') + '\r\n';
}

module.exports = {
  exportCsv, exportXlsx, exportRows, readFile, planImport, applyImport, template,
  parseNumber, parseBool, parseCsv, normaliseHeader, SPECS,
};
