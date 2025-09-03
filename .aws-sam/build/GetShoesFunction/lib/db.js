const mysql = require('mysql2/promise');
const { getDbConfig } = require('./config');

let cachedPool;
async function getPool() {
  if (cachedPool) return cachedPool;
  const cfg = await getDbConfig();
  cachedPool = mysql.createPool({
    host: cfg.host, user: cfg.user, password: cfg.password, database: cfg.database,
    waitForConnections: true, connectionLimit: 4, queueLimit: 0,
  });
  return cachedPool;
}
module.exports = { getPool };
