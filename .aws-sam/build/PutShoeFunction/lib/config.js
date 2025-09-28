// src/lib/config.js
// No AWS calls in Env mode. Only touch SM in demo mode.
async function getDbConfig() {
  const mode = process.env.CONFIG_SOURCE;
  console.log(`CONFIG_SOURCE=${mode}`);

  if (mode === 'SecretsManager') {
    const { SecretsManagerClient, GetSecretValueCommand } =
      require('@aws-sdk/client-secrets-manager');
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    const secretId = process.env.SECRET_NAME;
    if (!secretId) throw new Error('SECRET_NAME env var is not set');

    try {
      const sm = new SecretsManagerClient({ region });
      const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
      const s = JSON.parse(out.SecretString);
      return {
        host: s.host || s.hostname,
        user: s.user || s.username,
        password: s.password,
        database: s.database || s.dbname,
      };
    } catch (e) {
      console.error('secrets_manager_error', e); // don't log secrets
      throw e;
    }
  }

  // Env mode: values already injected at deploy time
  return {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

module.exports = { getDbConfig };

