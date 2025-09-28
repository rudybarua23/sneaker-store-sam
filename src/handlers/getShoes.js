const mysql = require('mysql2/promise');

let cachedConnection = null;
let cachedSecret = null;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Content-Type": "application/json"
};

async function getSecret() {
  const mode = process.env.CONFIG_SOURCE;
  console.log(`CONFIG_SOURCE=${mode}`);

  // Everyday (Env) mode: NO AWS calls
  if (mode !== 'SecretsManager') {
    return {
      host: process.env.DB_HOST,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      dbname: process.env.DB_NAME,
    };
  }

  if (cachedSecret) return cachedSecret;

  // Demo mode: lazy-load SM client so Env mode never bundles/calls it
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const secretName = process.env.SECRET_NAME || 'admin_cred';

  console.log('Retrieving database credentials from Secrets Manager...');
  const client = new SecretsManagerClient({ region });
  const response = await client.send(new GetSecretValueCommand({SecretId: secretName, VersionStage: "AWSCURRENT",}));
  console.log('Successfully retrieved secret from Secrets Manager.');

  // Normalize possible key variants:
  const s = JSON.parse(response.SecretString);
  cachedSecret = {
    host: s.host || s.hostname,
    username: s.username || s.user,
    password: s.password,
    dbname: s.dbname || s.database,
  };
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
    console.log('Lambda function started for GET all shoes (with inventory).');

    connection = await getConnection();

    const queryParams = event.queryStringParameters;
    let whereClause = '';
    let values = [];

    if (queryParams && queryParams.brand) {
      whereClause = 'WHERE s.brand = ?';
      values.push(queryParams.brand);
    }

    const query = `
      SELECT 
        s.id, s.name, s.brand, s.price, s.image,
        i.size, i.quantity
      FROM shoes s
      LEFT JOIN shoe_inventory i ON s.id = i.shoe_id
      ${whereClause}
      ORDER BY s.id, i.size
    `;

    console.log('Executing query:', query, 'with values:', values);
    const [rows] = await connection.query(query, values);

    // Group inventory under each shoe
    const shoesMap = new Map();

    for (const row of rows) {
      const shoeId = row.id;

      if (!shoesMap.has(shoeId)) {
        shoesMap.set(shoeId, {
          id: row.id,
          name: row.name,
          brand: row.brand,
          price: row.price,
          image: row.image,
          inventory: []
        });
      }

      if (row.size !== null && row.quantity !== null) {
        shoesMap.get(shoeId).inventory.push({
          size: parseFloat(row.size),
          quantity: row.quantity
        });
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS, 
      body: JSON.stringify(Array.from(shoesMap.values())),
    };

  } catch (error) {
    console.error('Error fetching shoes with inventory:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS, 
      body: JSON.stringify({ message: 'Error fetching shoes.', error: error.message }),
    };
  } finally {
    console.log('Lambda invocation complete. DB connection remains open for reuse.');
  }
};


