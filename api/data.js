/* Vercel serverless funkce: GET / PUT / DELETE /api/data = cloudová záloha dat přihlášeného uživatele.
   Web Investixu zůstává na GitHub Pages, tohle je jen neviditelný backend (volá se z prohlížeče).
   Nastavení na Vercelu (Environment Variables): DATABASE_URL = připojovací řetězec Postgresu (Neon).
   Ověření přihlášení nepotřebuje žádný tajný klíč - kontroluje se podpis tokenu veřejnými klíči Clerku. */
const postgres = require('postgres');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { createHandler } = require('./_handler');

const ISSUER = process.env.CLERK_ISSUER || 'https://true-redfish-2809.clerk.accounts.dev';
const ALLOWED_ORIGINS = [
  'https://kylianek.github.io',
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) : []),
];

const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

async function verifyToken(token, origin) {
  const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, clockTolerance: 5 });
  if (!payload.sub) throw new Error('token bez uživatele');
  if (payload.azp && payload.azp !== origin) throw new Error('token patří jiné aplikaci');
  return payload.sub;
}

let sql;
let tableReady;

function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL není nastavená');
  sql = sql || postgres(process.env.DATABASE_URL, { max: 1, prepare: false, idle_timeout: 20 });
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

module.exports = createHandler({ store, verifyToken, allowedOrigins: ALLOWED_ORIGINS });
