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
      return { statusCode: 400, body: JSON.stringify({ message: 'Shoe ID is required.' }) };
    }

    if (!event.body) {
      console.error('Missing request body.');
      return { statusCode: 400, body: JSON.stringify({ message: 'Request body is required.' }) };
    }

    const { name, brand, price, size, in_stock, image } = JSON.parse(event.body);

    if (!name || !brand || price == null || size == null || in_stock == null || image == null) {
      console.error('Missing one or more required shoe fields.');
      return { statusCode: 400, body: JSON.stringify({ message: 'All shoe fields are required.' }) };
    }

    connection = await getConnection();

    const updateQuery = `
      UPDATE shoes 
      SET name = ?, brand = ?, price = ?, size = ?, in_stock = ?, image = ?
      WHERE id = ?
    `;
    console.log(`Executing update query for shoe ID ${shoeId}`);
    const [result] = await connection.query(updateQuery, [name, brand, price, size, in_stock, image, shoeId]);

    if (result.affectedRows === 0) {
      console.warn(`Shoe with ID ${shoeId} not found for update.`);
      return { statusCode: 404, body: JSON.stringify({ message: 'Shoe not found.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Shoe updated successfully.' }) };

  } catch (error) {
    console.error('Error updating shoe:', error);
    return { statusCode: 500, body: JSON.stringify({ message: 'Error updating shoe.', error: error.message }) };
  } finally {
    // Do NOT close the connection to allow reuse.
    console.log('Lambda invocation complete. Database connection remains open for reuse.');
  }
};


