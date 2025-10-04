// handler.js
'use strict';

const mysql = require('mysql2/promise');

let cachedConn = null;
let cachedSecret = null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*', // set to http://localhost:5173 and/or your Amplify domain in prod
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

/** ---------- Secrets & DB Connection ---------- **/
async function getSecret() {
  const mode = process.env.CONFIG_SOURCE;
  console.log(`CONFIG_SOURCE=${mode || 'Env'}`);

  // Default: env vars (no AWS calls)
  if (mode !== 'SecretsManager') {
    return {
      host: process.env.DB_HOST,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      dbname: process.env.DB_NAME,
      port: Number(process.env.DB_PORT || 3306),
    };
  }

  if (cachedSecret) return cachedSecret;

  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const secretName = process.env.SECRET_NAME;

  if (!secretName) throw new Error('SECRET_NAME env var is required when CONFIG_SOURCE=SecretsManager');

  const client = new SecretsManagerClient({ region });
  const resp = await client.send(new GetSecretValueCommand({ SecretId: secretName, VersionStage: 'AWSCURRENT' }));
  const s = JSON.parse(resp.SecretString);

  cachedSecret = {
    host: s.host || s.hostname,
    username: s.username || s.user,
    password: s.password,
    dbname: s.dbname || s.database,
    port: Number(s.port || 3306),
  };
  return cachedSecret;
}

async function createConnection() {
  const secret = await getSecret();
  return mysql.createConnection({
    host: secret.host,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    port: secret.port,
    // keep these modest to avoid long API GW timeouts
    connectTimeout: 4000,
  });
}

// Return a healthy connection, recreating if needed
async function getConnection() {
  if (cachedConn && cachedConn.connection && cachedConn.connection.connection && cachedConn.connection.connection.state !== 'disconnected') {
    return cachedConn.connection;
  }
  const connection = await createConnection();
  cachedConn = { connection };
  return connection;
}

// If the connection dropped mid-query, retry once with a fresh connection
async function withDb(fn) {
  let conn = await getConnection();
  try {
    return await fn(conn);
  } catch (err) {
    const transient =
      /PROTOCOL_CONNECTION_LOST|ECONNRESET|ETIMEDOUT|EPIPE|read ECONNRESET|write EPIPE/i.test(String(err && err.message));
    if (!transient) throw err;
    console.warn('DB connection appears stale; recreating and retrying once…');
    cachedConn = null;
    conn = await getConnection();
    return await fn(conn);
  }
}

/** ---------- Auth Helpers ---------- **/
// API Gateway (REST User Pool authorizer or HTTP API JWT authorizer) injects claims here:
function getClaims(event) {
  return event?.requestContext?.authorizer?.jwt?.claims || event?.requestContext?.authorizer?.claims || {};
}

function isAdmin(claims) {
  const groups = claims['cognito:groups'];
  if (!groups) return false;
  return Array.isArray(groups) ? groups.includes('admin') : String(groups).split(',').includes('admin');
}

/** ---------- Response Helper ---------- **/
function resp(statusCode, bodyObj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: bodyObj != null ? JSON.stringify(bodyObj) : '',
  };
}

/** ---------- Lambda Handler ---------- **/
exports.handler = async (event) => {
  try {
    console.log('Incoming event:', JSON.stringify({
      routeKey: event.routeKey,
      path: event.rawPath || event.path,
      method: (event.requestContext?.http?.method || event.httpMethod),
    }));

    // 1) CORS preflight short-circuit
    const method = event.requestContext?.http?.method || event.httpMethod;
    if (method === 'OPTIONS') {
      return resp(200, null);
    }

    // 2) Authorize (API Gateway already validated the Access Token signature)
    const claims = getClaims(event);
    if (!isAdmin(claims)) {
      // You can also allow non-admin for safe methods like GET
      return resp(403, { message: 'Forbidden: admin role required' });
    }

    // 3) Route handling (we’ll implement DELETE /shoes/{id} here)
    const path = event.rawPath || event.path || '';
    const httpMethod = method || 'GET';

    // DELETE /shoes/{id}
    if (httpMethod === 'DELETE' && /\/shoes\/[^/]+$/.test(path)) {
      const shoeId = event.pathParameters?.id || path.split('/').pop();
      if (!shoeId) return resp(400, { message: 'Shoe ID is required.' });

      const result = await withDb(async (conn) => {
        await conn.beginTransaction();
        try {
          const [del] = await conn.query('DELETE FROM shoes WHERE id = ?', [shoeId]);
          if (del.affectedRows === 0) {
            await conn.rollback();
            return { notFound: true };
          }
          await conn.commit();
          return { ok: true };
        } catch (e) {
          await conn.rollback();
          throw e;
        }
      });

      if (result.notFound) return resp(404, { message: 'Shoe not found.' });
      return resp(200, { message: 'Shoe deleted successfully.' });
    }

    // (Optional) Stubs for future: POST /shoes and PUT /shoes/{id}
    // if (httpMethod === 'POST' && path.endsWith('/shoes')) { … }
    // if (httpMethod === 'PUT' && /\/shoes\/[^/]+$/.test(path)) { … }

    // 4) Fallback
    return resp(404, { message: 'Route not found.' });

  } catch (err) {
    console.error('Unhandled error:', err);
    return resp(500, { message: 'Internal Server Error', error: String(err && err.message || err) });
  } finally {
    // Intentionally keep connection open for reuse across warm invocations.
  }
};
