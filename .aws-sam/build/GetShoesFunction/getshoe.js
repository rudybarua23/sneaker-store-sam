const mysql = require('mysql2/promise');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secret_name = "admin_cred";
const client = new SecretsManagerClient({ region: "us-east-1" });

let cachedConnection = null;
let cachedSecret = null;

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
    connectTimeout: 30000
  });

  cachedConnection = { connection };
  return connection;
}

exports.handler = async (event) => {
  let connection;

  try {
    console.log('Lambda function started for GET shoe by ID (with inventory).');

    const shoeId = event.pathParameters?.id;

    if (!shoeId) {
      console.error('Missing shoe ID in path parameters.');
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Shoe ID is required.' }),
      };
    }

    connection = await getConnection();

    const query = `
      SELECT 
        s.id, s.name, s.brand, s.price, s.image,
        i.size, i.quantity
      FROM shoes s
      LEFT JOIN shoe_inventory i ON s.id = i.shoe_id
      WHERE s.id = ?
      ORDER BY i.size
    `;

    console.log(`Executing query for shoe ID: ${shoeId}`);
    const [rows] = await connection.query(query, [shoeId]);

    if (rows.length === 0) {
      console.warn(`Shoe with ID ${shoeId} not found.`);
      return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Shoe not found.' }),
      };
    }

    const shoe = {
      id: rows[0].id,
      name: rows[0].name,
      brand: rows[0].brand,
      price: rows[0].price,
      image: rows[0].image,
      inventory: []
    };

    for (const row of rows) {
      if (row.size !== null && row.quantity !== null) {
        shoe.inventory.push({
          size: parseFloat(row.size),
          quantity: row.quantity
        });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify(shoe),
    };

  } catch (error) {
    console.error('Error fetching shoe by ID:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Error fetching shoe.', error: error.message }),
    };
  } finally {
    console.log('Lambda invocation complete. Database connection remains open for reuse.');
  }
};


