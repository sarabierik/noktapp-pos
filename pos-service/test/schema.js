'use strict';
/**
 * Does the schema match what the service actually writes?
 *
 * The tables came from a multi-tenant web app where a PHP layer sat in front
 * of every write and always passed something. The desktop writes them
 * directly, so every NOT NULL column with no default is a landmine that goes
 * off in front of a customer, mid-service:
 *
 *     Column 'order_id' cannot be null
 *
 * is what a restaurant saw on its bill screen, three times, because a Z report
 * has no order and never did.
 *
 * Finding these by waiting for the error is not a plan. This suite asks the
 * schema instead: it reads every INSERT in the source, matches each column to
 * the argument that fills it, and fails if a NOT NULL column can receive null
 * or is never supplied at all. It also checks the enums and the columns the
 * reports depend on, because a column that quietly does not exist is the same
 * bug wearing a different hat - the price history was written to four columns
 * that were not there, inside a catch, and was empty for months.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/schema.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const SRC = path.join(__dirname, '..', 'src');
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

function sourceFiles(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (f !== 'node_modules') sourceFiles(p, out); }
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Split an argument array at top level, ignoring commas inside brackets. */
function splitArgs(raw) {
  const out = []; let depth = 0, cur = '';
  for (const ch of raw) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Can this argument expression be null? */
function canBeNull(a) {
  const s = a.trim();
  return s === 'null'
      || /\|\|\s*null$/.test(s)
      || /\?\?\s*null$/.test(s)
      || /^\w[\w.]*\s*\?\s*[\w.]+\s*:\s*null$/.test(s);
}

/** Every INSERT in the service, as {file, table, columns[], args[]}. */
function inserts() {
  const found = [];
  const re = /INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?\s*\(([^)]*)\)\s*VALUES\s*\(([^;]*?)\)\s*`?\s*,?\s*(\[[\s\S]{0,1200}?\])\s*\)/gi;
  for (const f of sourceFiles(SRC)) {
    const text = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(text))) {
      found.push({
        file: path.relative(SRC, f),
        table: m[1],
        columns: m[2].split(',').map(s => s.trim().replace(/`/g, '')),
        values: m[3].split(',').map(s => s.trim()),
        args: splitArgs(m[4].slice(1, -1)),
      });
    }
  }
  return found;
}

(async () => {
  await db.init();
  console.log('\nNOKTApp POS - schema structure\n');

  const cols = await db.query(
    `SELECT TABLE_NAME t, COLUMN_NAME col, DATA_TYPE dt, COLUMN_TYPE ct,
            COLUMN_DEFAULT def, EXTRA ex, IS_NULLABLE nul
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);

  const table = new Map();
  for (const r of cols) {
    if (!table.has(r.t)) table.set(r.t, new Map());
    table.get(r.t).set(r.col, r);
  }
  const generated = (r) =>
    String(r.ex).includes('auto_increment') || String(r.ex).includes('GENERATED');

  /* A column the INSERT must name, or the row cannot be created: NOT NULL and
   * nothing for the database to fall back on. */
  const mustSupply = (t, c) => {
    const r = table.get(t) && table.get(t).get(c);
    if (!r) return false;
    return r.nul === 'NO' && r.def === null && !generated(r);
  };

  /*
   * A column that must never be handed a null - which is NOT the same set.
   *
   * A DEFAULT only applies when the column is left OUT of the statement. Name
   * it and pass null and the default is not consulted; MariaDB rejects the row.
   * That is how `order_delete_logs.deleted_by int NOT NULL DEFAULT 0` still
   * threw: the owner signs in on the licence with no staff row, the code wrote
   * `userId || null`, and the one person allowed to delete a bill was the one
   * person who could not. The default made it look safe, so this check ignores
   * defaults entirely.
   */
  const mustNotBeNull = (t, c) => {
    const r = table.get(t) && table.get(t).get(c);
    if (!r) return false;
    return r.nul === 'NO' && !generated(r);
  };

  const all = inserts();

  await step('the source could be parsed for INSERT statements at all', () => {
    assert.ok(all.length > 20, 'only found ' + all.length + ' inserts - the parser is broken, ' +
      'and a green run would mean nothing');
  });

  await step('every column the service writes actually exists', () => {
    const bad = [];
    for (const ins of all) {
      if (!table.has(ins.table)) continue;          // a table this DB does not carry
      for (const c of ins.columns) {
        if (!/^\w+$/.test(c)) continue;
        if (!table.get(ins.table).has(c)) bad.push(`${ins.file}: ${ins.table}.${c}`);
      }
    }
    assert.strictEqual(bad.length, 0,
      'writing to columns that do not exist:\n    ' + bad.join('\n    '));
  });

  await step('no NOT NULL column is left out of an INSERT that creates the row', () => {
    const bad = [];
    const byTable = new Map();
    for (const ins of all) {
      if (!byTable.has(ins.table)) byTable.set(ins.table, new Set());
      for (const c of ins.columns) byTable.get(ins.table).add(c);
    }
    for (const [t, written] of byTable) {
      if (!table.has(t)) continue;
      for (const [c] of table.get(t)) {
        if (mustSupply(t, c) && !written.has(c)) bad.push(`${t}.${c}`);
      }
    }
    assert.strictEqual(bad.length, 0,
      'required columns never supplied:\n    ' + bad.join('\n    '));
  });

  await step('no NOT NULL column can receive null', () => {
    const bad = [];
    for (const ins of all) {
      if (!table.has(ins.table)) continue;
      let ai = 0;
      for (let i = 0; i < ins.columns.length; i++) {
        const v = ins.values[i];
        if (v === undefined) break;
        if (!v.includes('?')) continue;                 // a literal: NOW(), 0, 'pending'
        const arg = ins.args[ai++];
        if (arg === undefined) break;
        if (!mustNotBeNull(ins.table, ins.columns[i])) continue;
        if (canBeNull(arg)) {
          bad.push(`${ins.file}: ${ins.table}.${ins.columns[i]} <- ${arg.trim().slice(0, 50)}`);
        }
      }
    }
    assert.strictEqual(bad.length, 0,
      'null into a NOT NULL column:\n    ' + bad.join('\n    '));
  });

  /*
   * The specific structures the till depends on. An enum missing a value fails
   * exactly like a NOT NULL column does - at the counter, with the guest
   * waiting - and the static scan above cannot see it.
   */
  await step('print_jobs accepts a job that has no order', () => {
    const t = table.get('print_jobs');
    assert.ok(t, 'print_jobs missing');
    assert.strictEqual(t.get('order_id').nul, 'YES',
      'a Z report, an X report, a drawer pulse and a printer test have no order');
    for (const kind of ['order', 'receipt', 'report', 'drawer', 'test']) {
      assert.ok(t.get('job_type').ct.includes(`'${kind}'`),
        'print_jobs.job_type cannot hold ' + kind + ': ' + t.get('job_type').ct);
    }
  });

  await step('a bill can exist without a table and without a waiter', () => {
    const t = table.get('orders');
    assert.strictEqual(t.get('table_id').nul, 'YES', 'counter takeaway has no table');
    assert.strictEqual(t.get('waiter_id').nul, 'YES', 'an owner on the licence has no staff id');
  });

  await step('an order line can carry a note, a half portion and a frozen cost', () => {
    const t = table.get('order_items');
    assert.ok(t.get('note'), 'no note column: kitchen notes have nowhere to go');
    assert.ok(/decimal|float|double/i.test(t.get('qty').dt),
      'qty is ' + t.get('qty').dt + ' - half portions would silently round to whole ones');
    assert.ok(t.get('cost_price'), 'no cost_price: every margin would be a fiction');
    assert.ok(/decimal/i.test(t.get('cost_price').dt));
  });

  await step('a bill can be labelled, so two parties on one table can be told apart', () => {
    assert.ok(table.get('orders').get('bill_label'), 'no bill_label column');
  });

  await step('price changes have somewhere to go, including from an import', () => {
    const h = table.get('product_price_history');
    assert.ok(h.get('price') && h.get('effective_date'),
      'product_price_history is a history of prices, not a diff');
    const l = table.get('price_change_log');
    assert.ok(l.get('source').ct.includes("'import'"),
      'a price changed by importing a spreadsheet has no source to record: ' + l.get('source').ct);
  });

  await step('the profit and loss report has every column it reads', () => {
    const need = {
      orders: ['business_date', 'closed_at', 'status', 'is_deleted', 'exclude_from_reports',
               'total', 'discount_total', 'vat_total', 'grand_total'],
      order_items: ['qty', 'cost_price', 'line_total', 'vat_total', 'vat_rate', 'is_deleted'],
      order_payments: ['method', 'amount', 'is_deleted', 'voided_at'],
      daily_costs: ['date', 'category', 'amount'],
      products: ['cost_price', 'vat_rate'],
    };
    const missing = [];
    for (const [t, list] of Object.entries(need)) {
      for (const c of list) if (!table.get(t) || !table.get(t).has(c)) missing.push(`${t}.${c}`);
    }
    assert.strictEqual(missing.length, 0, 'kar/zarar reads columns that are not there: ' + missing.join(', '));
  });

  await step('money columns are decimal, never float', () => {
    /*
     * A float total is a bill that adds up differently depending on the order
     * the lines were entered in. Turkish VAT is computed to the kurus and a
     * fiscal device will refuse a receipt whose parts do not sum.
     */
    const bad = [];
    const moneyish = /(price|total|amount|cost|paid|discount|vat|balance)$/i;
    for (const [t, m] of table) {
      if (!t.match(/^(orders|order_items|order_payments|products|daily_costs|order_discounts)$/)) continue;
      for (const [c, r] of m) {
        if (!moneyish.test(c)) continue;
        if (/float|double/i.test(r.dt)) bad.push(`${t}.${c} is ${r.dt}`);
      }
    }
    assert.strictEqual(bad.length, 0, 'money stored as a float:\n    ' + bad.join('\n    '));
  });

  await step('every table the service writes is actually present', () => {
    const missing = [...new Set(all.map(i => i.table))].filter(t => !table.has(t));
    assert.strictEqual(missing.length, 0,
      'the service inserts into tables this database does not have: ' + missing.join(', '));
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ':\n      ' + f[2].split('\n').join('\n      '));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.message); process.exit(1); });
