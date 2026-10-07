import Database from "better-sqlite3";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const legacyDatabasePath = resolve(moduleDirectory, "../db.json");
let database;

const parseOrder = (row) => (row ? JSON.parse(row.data) : null);

const importLegacyDatabase = async (connection) => {
  if (connection.prepare("SELECT 1 FROM settings WHERE key = ?").get("legacy_json_imported")) return;

  let legacyData;
  try {
    legacyData = JSON.parse(await readFile(legacyDatabasePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const importData = connection.transaction(() => {
    const insertOrder = connection.prepare("INSERT OR IGNORE INTO orders (id, status, created_at, data) VALUES (?, ?, ?, ?)");
    for (const order of Array.isArray(legacyData.orders) ? legacyData.orders : []) {
      if (order?.id && order.status && order.createdAt) {
        insertOrder.run(order.id, order.status, order.createdAt, JSON.stringify(order));
      }
    }

    const insertVerifiedEmail = connection.prepare("INSERT OR IGNORE INTO verified_emails (email, verified_at) VALUES (?, ?)");
    for (const entry of Array.isArray(legacyData.verifiedEmails) ? legacyData.verifiedEmails : []) {
      const email = typeof entry === "string" ? entry : entry?.email;
      if (email) insertVerifiedEmail.run(email, typeof entry === "string" ? new Date().toISOString() : entry.verifiedAt || new Date().toISOString());
    }

    const insertPending = connection.prepare("INSERT OR IGNORE INTO pending_verifications (email, nonce, expires_at, last_sent_at, checkout) VALUES (?, ?, ?, ?, ?)");
    for (const entry of Array.isArray(legacyData.pendingVerifications) ? legacyData.pendingVerifications : []) {
      if (entry?.email && entry.nonce && Number.isFinite(entry.expiresAt) && Number.isFinite(entry.lastSentAt)) {
        insertPending.run(entry.email, entry.nonce, entry.expiresAt, entry.lastSentAt, JSON.stringify(entry.checkout || null));
      }
    }

    connection.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("legacy_json_imported", new Date().toISOString());
  });

  importData();
};

export const initializeDatabase = async () => {
  if (database) return;
  const databasePath = process.env.SQLITE_DB_PATH ? resolve(process.env.SQLITE_DB_PATH) : resolve(moduleDirectory, "../milk-villa.sqlite");
  await mkdir(dirname(databasePath), { recursive: true });

  const connection = new Database(databasePath);
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  connection.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
    CREATE TABLE IF NOT EXISTS verified_emails (
      email TEXT PRIMARY KEY,
      verified_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_verifications (
      email TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_sent_at INTEGER NOT NULL,
      checkout TEXT NOT NULL
    );
  `);

  try {
    await importLegacyDatabase(connection);
    database = connection;
  } catch (error) {
    connection.close();
    throw error;
  }
};

const getDatabase = () => {
  if (!database) throw new Error("SQLite database has not been initialized.");
  return database;
};

export const findVerifiedEmail = (email) => Boolean(getDatabase().prepare("SELECT 1 FROM verified_emails WHERE email = ?").get(email));

export const readPendingVerification = (email) => {
  const row = getDatabase().prepare("SELECT * FROM pending_verifications WHERE email = ?").get(email);
  return row ? { email: row.email, nonce: row.nonce, expiresAt: row.expires_at, lastSentAt: row.last_sent_at, checkout: JSON.parse(row.checkout) } : null;
};

export const savePendingVerification = (record) => {
  getDatabase()
    .prepare(
      `
    INSERT INTO pending_verifications (email, nonce, expires_at, last_sent_at, checkout)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      nonce = excluded.nonce,
      expires_at = excluded.expires_at,
      last_sent_at = excluded.last_sent_at,
      checkout = excluded.checkout
  `,
    )
    .run(record.email, record.nonce, record.expiresAt, record.lastSentAt, JSON.stringify(record.checkout || null));
};

export const completeEmailVerification = (email, nonce) =>
  getDatabase().transaction(() => {
    const connection = getDatabase();
    const row = connection.prepare("SELECT checkout FROM pending_verifications WHERE email = ? AND nonce = ? AND expires_at > ?").get(email, nonce, Date.now());
    if (!row) return null;
    connection.prepare("INSERT OR IGNORE INTO verified_emails (email, verified_at) VALUES (?, ?)").run(email, new Date().toISOString());
    connection.prepare("DELETE FROM pending_verifications WHERE email = ?").run(email);
    return JSON.parse(row.checkout);
  })();

export const saveOrder = (order) => {
  getDatabase().prepare("INSERT INTO orders (id, status, created_at, data) VALUES (?, ?, ?, ?)").run(order.id, order.status, order.createdAt, JSON.stringify(order));
};

export const countOrders = () => getDatabase().prepare("SELECT COUNT(*) AS total FROM orders").get().total;

export const listOrders = ({ offset, limit }) => {
  const connection = getDatabase();
  const total = connection.prepare("SELECT COUNT(*) AS total FROM orders").get().total;
  const orders = connection
    .prepare("SELECT data FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset)
    .map((row) => JSON.parse(row.data));
  const counts = Object.fromEntries(
    connection
      .prepare("SELECT status, COUNT(*) AS count FROM orders GROUP BY status")
      .all()
      .map(({ status, count }) => [status, count]),
  );
  return { orders, total, counts };
};

export const updateOrderStatus = (id, status, cancellationReason) =>
  getDatabase().transaction(() => {
    const connection = getDatabase();
    const order = parseOrder(connection.prepare("SELECT data FROM orders WHERE id = ?").get(id));
    if (!order) return { kind: "not-found" };
    if (order.status === "delivered") return { kind: "delivered" };
    if (order.status === status) return { kind: "same", order };
    if (order.status === "canceled") return { kind: "canceled" };

    const previousStatus = order.status;
    order.status = status;
    if (status === "canceled") order.cancellationReason = cancellationReason;
    connection.prepare("UPDATE orders SET status = ?, data = ? WHERE id = ?").run(status, JSON.stringify(order), id);
    return { kind: "updated", order, previousStatus };
  })();
