const mysql = require('mysql2/promise');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secret_name = "admin_cred";
const client = new SecretsManagerClient({ region: "us-east-1" });

let cachedConnection = null;
let cachedSecret = null;

const { getPool } = require('../lib/db');

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Content-Type": "application/json"
};

async function getSecret() {
  if (cachedSecret) return cachedSecret;

  console.log('Retrieving database credentials from Secrets Manager...');
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: secret_name,
      VersionStage: "AWSCURRENT",
    })
  );
  console.log('Successfully retrieved secret from Secrets Manager.');
  cachedSecret = JSON.parse(response.SecretString);
  return cachedSecret;
}

async function getConnection() {
  if (cachedConnection && cachedConnection.connection && cachedConnection.connection.state !== 'disconnected') {
    console.log('Reusing existing database connection.');
    return cachedConnection.connection;
  }

  const secret = await getSecret();

  console.log('Creating new database connection...');
  const connection = await mysql.createConnection({
    host: secret.host,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    connectTimeout: 30000 // Optional but good to keep
  });

  cachedConnection = { connection };
  return connection;
}

exports.handler = async (event) => {
  let connection;

  try {
    console.log('Lambda function started to update shoe by ID.');

    const shoeId = event.pathParameters?.id;

    if (!shoeId) {
      console.error('Missing shoe ID in path parameters.');
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ message: 'Shoe ID is required.' }) };
    }

    if (!event.body) {
      console.error('Missing request body.');
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ message: 'Request body is required.' }) };
    }

    const { name, brand, price, image, inventory } = JSON.parse(event.body);

    if (!name || !brand || price == null || image == null || !Array.isArray(inventory)) {
      console.error('Missing one or more required shoe fields.');
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ message: 'All shoe fields are required.' }) };
    }

    if (inventory.length === 0) {
      console.warn(`Empty inventory received for shoe ID ${shoeId}.`);
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ message: 'Inventory must include at least one size and quantity.' })
      };
    }

    connection = await getConnection();
    await connection.beginTransaction(); // Start transaction

    // Step 1: Update main shoe
    const [updateResult] = await connection.query(
      `UPDATE shoes SET name = ?, brand = ?, price = ?, image = ? WHERE id = ?`,
      [name, brand, price, image, shoeId]
    );

    if (updateResult.affectedRows === 0) {
      await connection.rollback(); // cancel transaction
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ message: 'Shoe not found.' }) };
    }

    // Step 2: Delete old inventory
    await connection.query(`DELETE FROM shoe_inventory WHERE shoe_id = ?`, [shoeId]);

    // Step 3: Batch insert updated inventory
    const batchSize = 10;
    const inventoryRows = inventory.map(({ size, quantity }) => [shoeId, size, quantity]);

    for (let i = 0; i < inventoryRows.length; i += batchSize) {
      const batch = inventoryRows.slice(i, i + batchSize);
      await connection.query(
        `INSERT INTO shoe_inventory (shoe_id, size, quantity) VALUES ?`,
        [batch]
      );
    }

    await connection.commit(); // All good, save changes
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ message: 'Shoe updated successfully.' }) };

  } catch (error) {
    if (connection) await connection.rollback(); // Revert everything
    console.error('Error updating shoe:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ message: 'Error updating shoe.', error: error.message })
    };
  } finally {
    console.log('Lambda invocation complete. Database connection remains open for reuse.');
  }
};



