const { createClient } = require("redis");

const client = createClient({
  url: process.env.REDIS_URL || "redis://redis:6379",
});

client.on("error", (err) => console.error("[redis] client error", err));
client.on("connect", () => console.log("[redis] connected"));

async function waitForRedis(retries = 20, delayMs = 1500) {
  for (let i = 1; i <= retries; i++) {
    try {
      if (!client.isOpen) await client.connect();
      await client.ping();
      console.log("[redis] ready");
      return;
    } catch (err) {
      console.log(`[redis] not ready yet (attempt ${i}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Could not connect to Redis after retries");
}

const CACHE_TTL_SECONDS = 60 * 60; // 1 hour cache for hot short codes
const URL_CACHE_PREFIX = "url:";
const CLICK_BUFFER_PREFIX = "clicks:"; // pending click counts not yet flushed to Postgres
const ALIAS_LOCK_PREFIX = "lock:alias:";

module.exports = {
  client,
  waitForRedis,
  CACHE_TTL_SECONDS,
  URL_CACHE_PREFIX,
  CLICK_BUFFER_PREFIX,
  ALIAS_LOCK_PREFIX,
};
