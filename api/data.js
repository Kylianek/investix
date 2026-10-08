/* Vercel serverless funkce: GET / PUT / DELETE /api/data = cloudová záloha dat přihlášeného uživatele.
   Web Investixu zůstává na GitHub Pages, tohle je jen neviditelný backend (volá se z prohlížeče).
   Databáze: Environment Variable DATABASE_URL (nebo POSTGRES_URL, viz _db.js).
   Ověření přihlášení nepotřebuje žádný tajný klíč - kontroluje se podpis tokenu veřejnými klíči Clerku. */
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { createHandler } = require('./_handler');
const { store } = require('./_db');

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

module.exports = createHandler({ store, verifyToken, allowedOrigins: ALLOWED_ORIGINS });
