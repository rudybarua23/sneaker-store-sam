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



