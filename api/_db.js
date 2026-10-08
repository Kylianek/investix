/* Připojení k Postgresu (Neon) a úložiště dat uživatelů. Vercel při propojení Neonu nastaví
   DATABASE_URL a POSTGRES_URL - použije se první, která existuje. */
const postgres = require('postgres');

let sql;
let tableReady;

function connectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

function db() {
  const url = connectionString();
  if (!url) throw new Error('DATABASE_URL není nastavená');
  sql = sql || postgres(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10 });
  tableReady =
    tableReady ||
    sql`create table if not exists investix_data (
      user_id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )`.catch((e) => {
      tableReady = null;
      throw e;
    });
  return tableReady.then(() => sql);
}

const store = {
  async load(userId) {
    const q = await db();
    const [row] = await q`select data, updated_at from investix_data where user_id = ${userId}`;
    return row || null;
  },
  async save(userId, data) {
    const q = await db();
    const [row] = await q`
      insert into investix_data (user_id, data, updated_at)
      values (${userId}, ${q.json(data)}, now())
      on conflict (user_id) do update set data = excluded.data, updated_at = now()
      returning updated_at`;
    return row.updated_at;
  },
  async remove(userId) {
    const q = await db();
    await q`delete from investix_data where user_id = ${userId}`;
  },
};

/** Diagnostika pro /api/health - nikdy nevrací adresu ani heslo, jen jestli to funguje. */
async function ping() {
  if (!connectionString()) return { databaseUrlSet: false };
  try {
    const q = await db();
    await q`select 1`;
    return { databaseUrlSet: true, databaseReachable: true, tableReady: true };
  } catch (e) {
    return { databaseUrlSet: true, databaseReachable: false, reason: (e && e.code) || 'unknown' };
  }
}

module.exports = { store, ping };
