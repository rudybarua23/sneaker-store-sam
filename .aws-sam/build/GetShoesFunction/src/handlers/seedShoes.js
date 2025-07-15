const mysql = require('mysql2/promise');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secret_name = "admin_cred";
const client = new SecretsManagerClient({ region: "us-east-1" });

console.log('forcing cold start');

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
        body: JSON.stringify({ message: 'Invalid or missing shoe data.' }),
      };
    }

    // Prepare batch insert
    const shoeValues = shoes.map(shoe => [
      shoe.name,
      shoe.brand,
      shoe.price,
      shoe.size,
      shoe.in_stock,
      shoe.image
    ]);

    const batchSize = 10;
    let totalInserted = 0;

    for (let i = 0; i < shoeValues.length; i += batchSize) {
      const batch = shoeValues.slice(i, i + batchSize);
      console.log(`Inserting batch: ${JSON.stringify(batch)}`);
      const insertQuery = 'INSERT INTO shoes (name, brand, price, size, in_stock, image) VALUES ?';
      const [result] = await connection.query(insertQuery, [batch]);
      console.log(`Inserted batch of ${result.affectedRows} shoes.`);
      totalInserted += result.affectedRows;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Shoes seeded successfully! Inserted ${totalInserted} shoes.` }),
    };
  } catch (error) {
    console.error('Error occurred:', error);
    console.error('Error stack trace:', error.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Seeding failed.', error: error.message }),
    };
  } finally {
    // Do NOT close the connection to allow reuse.
    console.log('Lambda invocation complete. Database connection remains open for reuse.');
  }
};

