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
    connectTimeout: 30000 // 30 seconds
  });

  cachedConnection = { connection };
  return connection;
}

exports.handler = async (event) => {
  let connection;

  try {
    console.log('Lambda function started.');

    connection = await getConnection();

    // Bulletproof body parsing
    console.log('Parsing incoming sneaker data...');
    let requestBody;

    if (event.body) {
      if (typeof event.body === 'string') {
        requestBody = JSON.parse(event.body);
      } else {
        requestBody = event.body;
      }
    } else {
      requestBody = event;
    }

    const shoes = requestBody.shoes;

    console.log('Shoes data received:', JSON.stringify(shoes));

    if (!shoes || !Array.isArray(shoes) || shoes.length === 0) {
      console.error('Invalid or missing shoe data.');
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ message: 'Invalid or missing shoe data.' }),
      };
    }

    const batchSize = 10;
    let totalInserted = 0;

    for (let i = 0; i < shoes.length; i += batchSize) {
      const shoeBatch = shoes.slice(i, i + batchSize);
      const shoeValues = shoeBatch.map(({ name, brand, price, image }) => [name, brand, price, image]);

      // Insert batch of shoes
      const [shoeResult] = await connection.query(
        `INSERT INTO shoes (name, brand, price, image) VALUES ?`,
        [shoeValues]
      );

      const insertedIds = shoeBatch.map((_, index) => shoeResult.insertId + index);
      totalInserted += shoeBatch.length;

      // Collect all inventory rows for this batch
      let inventoryRows = [];

      shoeBatch.forEach((shoe, index) => {
        const shoeId = insertedIds[index];
        if (Array.isArray(shoe.inventory)) {
          shoe.inventory.forEach(({ size, quantity }) => {
            inventoryRows.push([shoeId, size, quantity]);
          });
        }
      });

      // Insert inventory in batches of 10
      for (let j = 0; j < inventoryRows.length; j += batchSize) {
        const inventoryBatch = inventoryRows.slice(j, j + batchSize);
        await connection.query(
          `INSERT INTO shoe_inventory (shoe_id, size, quantity) VALUES ?`,
          [inventoryBatch]
        );
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ message: `Shoes seeded successfully! Inserted ${totalInserted} shoes.` }),
    };
  } catch (error) {
    console.error('Error occurred:', error);
    console.error('Error stack trace:', error.stack);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ message: 'Seeding failed.', error: error.message }),
    };
  } finally {
    // Do NOT close the connection to allow reuse.
    console.log('Lambda invocation complete. Database connection remains open for reuse.');
  }
};

