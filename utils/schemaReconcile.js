/**
 * utils/schemaReconcile.js — keep the live schema intact across a DB restore
 *
 * WHY THIS EXISTS
 * ───────────────
 * Backup & Restore replaces the ENTIRE live database file with the uploaded one.
 * The app builds its schema at boot (CREATE TABLE IF NOT EXISTS + dozens of
 * `ALTER TABLE ... ADD COLUMN` migrations in utils/db.js). A backup taken before
 * a column was added therefore brings back the OLD table layout, and the running
 * server never re-runs those boot migrations. Result: errors such as
 *   "table deleted_users has no column named password_hash"
 * on Start New Semester / Delete User until the next restart.
 *
 * HOW IT WORKS
 * ────────────
 *   1. captureSchema(db)           — before restoring, record the live schema
 *                                    (tables, columns, indexes) the code expects.
 *   2. restore the uploaded file   — (route handler)
 *   3. reconcileSchema(db, snap)   — add whatever the restore removed:
 *                                    missing tables, columns and indexes.
 *
 * It is generic on purpose: new migrations added to db.js later are covered
 * automatically, with nothing to keep in sync here.
 * It only ever ADDS structure; it never drops or rewrites restored data.
 */

const log = require('./logger');

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Literal defaults are legal in ADD COLUMN as-is; anything else must be parenthesised. */
function formatDefault(dflt) {
  if (dflt === null || dflt === undefined) return '';
  const d = String(dflt).trim();
  if (/^(-?\d+(\.\d+)?|'(?:[^']|'')*'|NULL|TRUE|FALSE)$/i.test(d)) return ` DEFAULT ${d}`;
  return ` DEFAULT (${d})`;
}

/** Snapshot of the schema this code version expects. Call BEFORE restoring. */
function captureSchema(db) {
  const tables = {};
  const tableRows = db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`
  ).all();
  for (const t of tableRows) {
    if (/^\s*CREATE\s+VIRTUAL/i.test(t.sql)) continue; // none today; shadow tables would need special care
    tables[t.name] = { sql: t.sql, columns: db.prepare(`PRAGMA table_info(${q(t.name)})`).all() };
  }
  const indexes = db.prepare(
    `SELECT name, tbl_name AS tbl, sql FROM sqlite_master
      WHERE type = 'index' AND sql IS NOT NULL`
  ).all(); // sql IS NULL = auto-indexes from PRIMARY KEY / UNIQUE, recreated with their table
  return { tables, indexes };
}

/**
 * Re-apply anything in `snapshot` that is missing from `db`. Call AFTER restoring.
 * @returns {{tablesCreated:string[], columnsAdded:string[], indexesCreated:string[], failures:string[]}}
 */
function reconcileSchema(db, snapshot) {
  const report = { tablesCreated: [], columnsAdded: [], indexesCreated: [], failures: [] };
  const fail = (what, e) => {
    const msg = `${what}: ${e.message}`;
    report.failures.push(msg);
    log.error(`[schema-reconcile] ${msg}`);
  };

  // 1. Tables the backup predates entirely
  const existing = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name)
  );
  for (const [name, def] of Object.entries(snapshot.tables)) {
    if (existing.has(name)) continue;
    try { db.exec(def.sql); report.tablesCreated.push(name); existing.add(name); }
    catch (e) { fail(`create table ${name}`, e); }
  }

  // 2. Columns the backup predates
  for (const [name, def] of Object.entries(snapshot.tables)) {
    if (report.tablesCreated.includes(name)) continue; // just created in full
    const have = new Set(db.prepare(`PRAGMA table_info(${q(name)})`).all().map(c => c.name));
    for (const col of def.columns) {
      if (have.has(col.name)) continue;
      if (col.pk) { fail(`add ${name}.${col.name}`, new Error('primary-key column cannot be added in place')); continue; }

      // Strictest definition first, then relax: SQLite refuses NOT NULL without a
      // constant default, and refuses non-constant defaults like datetime('now').
      const type = col.type ? ` ${col.type}` : '';
      const attempts = [];
      if (col.notnull && col.dflt_value !== null) attempts.push(`${type} NOT NULL${formatDefault(col.dflt_value)}`);
      attempts.push(`${type}${formatDefault(col.dflt_value)}`);
      attempts.push(type);

      let added = false, lastErr = null;
      for (const tail of attempts) {
        try { db.exec(`ALTER TABLE ${q(name)} ADD COLUMN ${q(col.name)}${tail}`); added = true; break; }
        catch (e) { lastErr = e; }
      }
      if (added) report.columnsAdded.push(`${name}.${col.name}`);
      else fail(`add column ${name}.${col.name}`, lastErr);
    }
  }

  // 3. Indexes (after columns, so indexes on re-added columns succeed)
  const haveIdx = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map(r => r.name)
  );
  for (const idx of snapshot.indexes) {
    if (haveIdx.has(idx.name) || !existing.has(idx.tbl)) continue;
    try { db.exec(idx.sql); report.indexesCreated.push(idx.name); }
    catch (e) { fail(`create index ${idx.name}`, e); } // e.g. UNIQUE index vs. duplicate rows in old data
  }

  return report;
}

module.exports = { captureSchema, reconcileSchema };
