const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

async function getDbConfig() {
  if (process.env.CONFIG_SOURCE === 'SecretsManager') {
    const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
    const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME }));
    return JSON.parse(res.SecretString); // { host, user, password, database }
  }
  // Env mode (values already injected by SAM via SSM dynamic refs)
  return {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

module.exports = { getDbConfig };
