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
    console.log('Lambda function started for DELETE shoe by ID.');

    const shoeId = event.pathParameters?.id;

    if (!shoeId) {
      console.error('Missing shoe ID in path parameters.');
      return { statusCode: 400, body: JSON.stringify({ message: 'Shoe ID is required.' }) };
    }

    connection = await getConnection();
    await connection.beginTransaction();

    const [deleteResult] = await connection.query(`DELETE FROM shoes WHERE id = ?`, [shoeId]);

    if (deleteResult.affectedRows === 0) {
      await connection.rollback();
      return { statusCode: 404, body: JSON.stringify({ message: 'Shoe not found.' }) };
    }

    await connection.commit();
    return { statusCode: 200, body: JSON.stringify({ message: 'Shoe and inventory deleted successfully.' }) };

  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error deleting shoe:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Error deleting shoe.', error: error.message })
    };
  } finally {
    console.log('Lambda delete complete. DB connection stays open.');
  }
};

