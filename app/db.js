const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PGHOST || "postgres",
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER || "shortener",
  password: process.env.PGPASSWORD || "shortener",
  database: process.env.PGDATABASE || "shortener",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  // Catches errors on idle clients so a single bad connection doesn't
  // crash the whole process.
  console.error("[postgres] unexpected error on idle client", err);
});

async function waitForDb(retries = 20, delayMs = 1500) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("[postgres] connected");
      return;
    } catch (err) {
      console.log(`[postgres] not ready yet (attempt ${i}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Could not connect to Postgres after retries");
}

module.exports = { pool, waitForDb };
