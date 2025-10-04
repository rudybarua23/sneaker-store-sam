// src/handlers/updateShoes.js
'use strict';

const mysql = require('mysql2/promise');

let cachedConnection = null;   // { connection }
let cachedSecret = null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
  'Content-Type': 'application/json',
};

/* -------------------- Auth helpers -------------------- */
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
  const secretName = process.env.SECRET_NAME || 'admin_cred';

  const client = new SecretsManagerClient({ region });
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretName, VersionStage: 'AWSCURRENT' })
  );
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
    port: secret.port,
    connectTimeout: 4000,
  });
}

async function getConnection() {
  if (
    cachedConnection &&
    cachedConnection.connection &&
    cachedConnection.connection.connection &&
    cachedConnection.connection.connection.state !== 'disconnected'
  ) {
    return cachedConnection.connection;
  }
  const connection = await createConnection();
  cachedConnection = { connection };
  return connection;
}

/* -------------------- Helpers: parse JSON body -------------------- */
function parseJsonBody(event) {
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
  } catch {
    return null;
  }
}

/* -------------------- PUT logic: /shoes/{id} -------------------- */
async function handlePutUpdate(event, shoeId) {
  const body = parseJsonBody(event);
  if (!body) return resp(400, { message: 'Invalid JSON body' });

  // Partial shoe fields + optional full inventory replace
  const { name, brand, price, image, inventory } = body;

  const sets = [];
  const vals = [];
  if (name != null)  { sets.push('name = ?');  vals.push(String(name)); }
  if (brand != null) { sets.push('brand = ?'); vals.push(String(brand)); }
  if (price != null) { sets.push('price = ?'); vals.push(Number(price)); }
  if (image != null) { sets.push('image = ?'); vals.push(image || null); }

  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    if (sets.length) {
      const [upd] = await conn.query(
        `UPDATE shoes SET ${sets.join(', ')} WHERE id = ?`,
        [...vals, shoeId]
      );
      if (upd.affectedRows === 0) {
        await conn.rollback();
        return resp(404, { message: 'Shoe not found.' });
      }
    } else {
      // if only inventory is provided, make sure shoe exists
      const [exists] = await conn.query('SELECT id FROM shoes WHERE id = ?', [shoeId]);
      if (!exists || !exists.length) {
        await conn.rollback();
        return resp(404, { message: 'Shoe not found.' });
      }
    }

    if (Array.isArray(inventory)) {
      // Replace entire inventory
      await conn.query('DELETE FROM shoe_inventory WHERE shoe_id = ?', [shoeId]);

      const rows = [];
      for (const item of inventory) {
        if (item && item.size != null) {
          rows.push([Number(shoeId), Number(item.size), Number(item.quantity || 1)]);
        }
      }
      if (rows.length) {
        const batchSize = 10;
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          await conn.query(
            'INSERT INTO shoe_inventory (shoe_id, size, quantity) VALUES ?',
            [batch]
          );
        }
      }
    }

    const [rows] = await conn.query('SELECT * FROM shoes WHERE id = ?', [shoeId]);
    await conn.commit();
    return resp(200, rows && rows[0] ? rows[0] : { id: Number(shoeId) });
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

/* -------------------- PATCH logic: /shoes/{id}/inventory -------------------- */
/**
 * Body:
 *   { size, quantity }  // absolute set
 *   OR
 *   { size, delta }     // increment/decrement; won’t go below 0
 */
async function handlePatchInventory(event, shoeId) {
  const body = parseJsonBody(event);
  if (!body) return resp(400, { message: 'Invalid JSON body' });

  const size = Number(body.size);
  const hasQuantity = body.quantity != null;
  const hasDelta = body.delta != null;

  if (!Number.isFinite(size)) return resp(400, { message: 'size (number) is required.' });
  if (hasQuantity && hasDelta) return resp(400, { message: 'Provide either "quantity" or "delta", not both.' });
  if (!hasQuantity && !hasDelta) return resp(400, { message: 'Provide "quantity" or "delta".' });

  const conn = await getConnection();

  // Ensure shoe exists
  const [exists] = await conn.query('SELECT id FROM shoes WHERE id = ?', [shoeId]);
  if (!exists || !exists.length) return resp(404, { message: 'Shoe not found.' });

  if (hasQuantity) {
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      return resp(400, { message: '"quantity" must be a non-negative number.' });
    }
    // Upsert absolute value
    await conn.query(
      'INSERT INTO shoe_inventory (shoe_id, size, quantity) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)',
      [Number(shoeId), size, quantity]
    );
  } else {
    const delta = Number(body.delta);
    if (!Number.isFinite(delta)) return resp(400, { message: '"delta" must be a number.' });

    if (delta > 0) {
      await conn.query(
        'INSERT INTO shoe_inventory (shoe_id, size, quantity) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)',
        [Number(shoeId), size, delta]
      );
    } else if (delta < 0) {
      // Don’t allow negative quantities; if row missing, 400
      const [curRows] = await conn.query(
        'SELECT quantity FROM shoe_inventory WHERE shoe_id = ? AND size = ?',
        [Number(shoeId), size]
      );
      if (!curRows || !curRows.length) {
        return resp(400, { message: 'Cannot decrement: inventory row does not exist for this size.' });
      }
      await conn.query(
        'UPDATE shoe_inventory SET quantity = GREATEST(0, quantity + ?) WHERE shoe_id = ? AND size = ?',
        [delta, Number(shoeId), size]
      );
    }
  }

  const [rows] = await conn.query(
    'SELECT id, shoe_id, size, quantity FROM shoe_inventory WHERE shoe_id = ? AND size = ?',
    [Number(shoeId), size]
  );
  return resp(200, rows && rows[0] ? rows[0] : { shoe_id: Number(shoeId), size, quantity: 0 });
}

/* -------------------- Main handler: route by method+path -------------------- */
exports.handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    if (method === 'OPTIONS') return resp(200, null);

    const claims = getClaims(event);
    if (!isAdmin(claims)) return resp(403, { message: 'Forbidden: admin role required' });

    const path = event.rawPath || event.path || '';
    const idFromPath = event.pathParameters?.id || (path.split('/').filter(Boolean).pop());

    // PATCH /shoes/{id}/inventory
    if (method === 'PATCH' && /\/shoes\/[^/]+\/inventory$/.test(path)) {
      if (!idFromPath) return resp(400, { message: 'Shoe ID is required.' });
      return await handlePatchInventory(event, idFromPath);
    }

    // PUT /shoes/{id}
    if (method === 'PUT' && /\/shoes\/[^/]+$/.test(path)) {
      if (!idFromPath) return resp(400, { message: 'Shoe ID is required.' });
      return await handlePutUpdate(event, idFromPath);
    }

    return resp(404, { message: 'Route not found.' });
  } catch (err) {
    console.error('Unhandled error:', err);
    return resp(500, { message: 'Internal Server Error', error: String(err && err.message || err) });
  } finally {
    // keep connection open for reuse
  }
};





