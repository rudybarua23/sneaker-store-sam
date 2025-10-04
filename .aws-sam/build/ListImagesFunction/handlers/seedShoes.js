// handler.js
'use strict';

const mysql = require('mysql2/promise');

let cachedConnection = null;   // { connection }
let cachedSecret = null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

/* -------------------- Auth helpers -------------------- */
// Works for REST (requestContext.authorizer.claims) and HTTP API (requestContext.authorizer.jwt.claims)
function getClaims(event) {
  return (
    event?.requestContext?.authorizer?.jwt?.claims ||
    event?.requestContext?.authorizer?.claims ||
    {}
  );
}
function isAdmin(claims) {
  const groups = claims['cognito:groups'];
  if (!groups) return false;
  return Array.isArray(groups) ? groups.includes('admin') : String(groups).split(',').includes('admin');
}
function resp(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: body == null ? '' : JSON.stringify(body) };
}
/* ------------------------------------------------------ */

/** ---------- Secrets & DB (Env vs Secrets Manager) ---------- **/
async function getSecret() {
  const mode = process.env.CONFIG_SOURCE;
  console.log(`CONFIG_SOURCE=${mode || 'Env'}`);

  // Everyday mode: get creds from env, no AWS API calls
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

  // Demo mode: lazy-load SM client only when needed
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const secretName = process.env.SECRET_NAME || 'admin_cred';

  console.log('Retrieving database credentials from Secrets Manager…');
  const client = new SecretsManagerClient({ region });
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretName, VersionStage: 'AWSCURRENT' })
  );
  console.log('Successfully retrieved secret from Secrets Manager.');

  const s = JSON.parse(response.SecretString);
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
    port: secret.port,               // <-- ensure correct port is used
    connectTimeout: 30000,           // modest timeout; avoids long API GW waits
  });
}

// Return a healthy connection, recreating if needed
async function getConnection() {
  if (
    cachedConnection &&
    cachedConnection.connection &&
    cachedConnection.connection.connection &&                            // inner socket
    cachedConnection.connection.connection.state !== 'disconnected'      // mysql2's underlying state
  ) {
    return cachedConnection.connection;
  }
  const connection = await createConnection();
  cachedConnection = { connection };
  return connection;
}

// If the connection dropped mid-query, retry once with a fresh connection
async function withDb(fn) {
  let conn = await getConnection();
  try {
    return await fn(conn);
  } catch (err) {
    const transient = /PROTOCOL_CONNECTION_LOST|ECONNRESET|ETIMEDOUT|EPIPE|read ECONNRESET|write EPIPE/i.test(
      String(err && err.message)
    );
    if (!transient) throw err;
    console.warn('DB connection appears stale; recreating and retrying once…');
    cachedConnection = null;
    conn = await getConnection();
    return await fn(conn);
  }
}

/** ----------------------- Handler (POST /shoes) ----------------------- **/
exports.handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod || 'POST';
    console.log('Seed/Create Shoes invoked. Method:', method);

    // CORS preflight
    if (method === 'OPTIONS') return resp(200, null);

    // Require Cognito admin (API Gateway validates the token; we just check claims)
    const claims = getClaims(event);
    if (!isAdmin(claims)) {
      return resp(403, { message: 'Forbidden: admin role required' });
    }

    // Parse body safely
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
    } catch {
      return resp(400, { message: 'Invalid JSON body' });
    }

    // Support BOTH payload shapes:
    // A) { shoes: [{ name, brand, price, image, inventory:[{size,quantity}] }, ...] }
    // B) { name, brand, price, size, image }  (single item form)
    let shoes = body.shoes;
    if (!Array.isArray(shoes)) {
      const { name, brand, price, size, image, inventory } = body || {};
      if (name && brand && price != null) {
        shoes = [{
          name,
          brand,
          price,
          image,
          inventory: Array.isArray(inventory)
            ? inventory
            : (size != null ? [{ size, quantity: 1 }] : []),
        }];
      }
    }

    console.log('Shoes payload received:', JSON.stringify(shoes));
    if (!shoes || !Array.isArray(shoes) || shoes.length === 0) {
      return resp(400, { message: 'Invalid or missing shoe data.' });
    }

    const result = await withDb(async (conn) => {
      const batchSize = 10;
      let totalInserted = 0;
      const createdRows = [];

      for (let i = 0; i < shoes.length; i += batchSize) {
        const shoeBatch = shoes.slice(i, i + batchSize);
        const shoeValues = shoeBatch.map(({ name, brand, price, image }) => [
          name,
          brand,
          Number(price),
          image || null,
        ]);

        // Insert batch of shoes
        const [shoeResult] = await conn.query(
          'INSERT INTO shoes (name, brand, price, image) VALUES ?',
          [shoeValues]
        );

        const insertedIds = shoeBatch.map((_, idx) => shoeResult.insertId + idx);
        totalInserted += shoeBatch.length;

        // If a single create, fetch the created row so UI can append it
        if (shoes.length === 1) {
          const [rows] = await conn.query('SELECT * FROM shoes WHERE id = ?', [insertedIds[0]]);
          if (rows && rows[0]) createdRows.push(rows[0]);
        }

        // Collect all inventory rows for this batch
        const invRows = [];
        shoeBatch.forEach((shoe, idx) => {
          const shoeId = insertedIds[idx];
          if (Array.isArray(shoe.inventory)) {
            shoe.inventory.forEach(({ size, quantity }) => {
              if (size != null) {
                invRows.push([shoeId, Number(size), Number(quantity || 1)]);
              }
            });
          }
        });

        // Insert inventory in chunks
        for (let j = 0; j < invRows.length; j += batchSize) {
          const invBatch = invRows.slice(j, j + batchSize);
          if (invBatch.length) {
            await conn.query(
              'INSERT INTO shoe_inventory (shoe_id, size, quantity) VALUES ?',
              [invBatch]
            );
          }
        }
      }

      return { totalInserted, createdRows };
    });

    // Response
    if (result.createdRows.length === 1 && shoes.length === 1) {
      return resp(201, result.createdRows[0]);
    }
    return resp(200, { message: `Shoes seeded successfully! Inserted ${result.totalInserted} shoes.` });

  } catch (err) {
    console.error('Error occurred:', err);
    return resp(500, { message: 'Seeding/creation failed.', error: String(err && err.message || err) });
  } finally {
    // Keep connection open for reuse across warm invocations.
    console.log('Invocation complete. DB connection left open for reuse.');
  }
};

