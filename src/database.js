import Database from "better-sqlite3";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { products as defaultProducts } from "./products.js";

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
    const insertOrder = connection.prepare("INSERT OR IGNORE INTO orders (id, status, created_at, data, latitude, longitude, distance_km) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const order of Array.isArray(legacyData.orders) ? legacyData.orders : []) {
      if (order?.id && order.status && order.createdAt) {
        insertOrder.run(order.id, order.status, order.createdAt, JSON.stringify(order), Number.isFinite(order.latitude) ? order.latitude : null, Number.isFinite(order.longitude) ? order.longitude : null, Number.isFinite(order.distanceKm) ? order.distanceKm : null);
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
  const configuredPath = process.env.SQLITE_DB_PATH;
  if (process.env.NODE_ENV === "production" && (!configuredPath || !isAbsolute(configuredPath))) {
    throw new Error("SQLITE_DB_PATH must be set to an absolute path on persistent storage in production.");
  }
  const databasePath = configuredPath ? resolve(configuredPath) : resolve(moduleDirectory, "../milk-villa.sqlite");
  if (process.env.NODE_ENV === "production") {
    const directory = await stat(dirname(databasePath)).catch((error) => {
      if (error.code === "ENOENT") throw new Error(`SQLite storage directory does not exist: ${dirname(databasePath)}. Verify the persistent disk is mounted.`);
      throw error;
    });
    if (!directory.isDirectory()) throw new Error(`SQLite storage path is not a directory: ${dirname(databasePath)}.`);
  } else {
    await mkdir(dirname(databasePath), { recursive: true });
  }

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
      data TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      distance_km REAL
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
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL CHECK (price >= 0),
      unit TEXT NOT NULL,
      description TEXT NOT NULL,
      emoji TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS products_category_idx ON products (category);
  `);

  try {
    const seedProduct = connection.prepare("INSERT OR IGNORE INTO products (id, name, category, price, unit, description, emoji) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const seedProducts = connection.transaction(() => {
      for (const product of defaultProducts) {
        seedProduct.run(product.id, product.name, product.category, product.price, product.unit, product.description, product.emoji);
      }
    });
    seedProducts();

    const orderColumns = new Set(connection.pragma("table_info(orders)").map(({ name }) => name));
    if (!orderColumns.has("latitude")) connection.exec("ALTER TABLE orders ADD COLUMN latitude REAL");
    if (!orderColumns.has("longitude")) connection.exec("ALTER TABLE orders ADD COLUMN longitude REAL");
    if (!orderColumns.has("distance_km")) connection.exec("ALTER TABLE orders ADD COLUMN distance_km REAL");

    const backfillOrderCoordinates = connection.transaction(() => {
      const updateCoordinates = connection.prepare("UPDATE orders SET latitude = COALESCE(latitude, ?), longitude = COALESCE(longitude, ?), distance_km = COALESCE(distance_km, ?) WHERE id = ?");
      const rows = connection.prepare("SELECT id, data FROM orders WHERE latitude IS NULL OR longitude IS NULL OR distance_km IS NULL").all();
      for (const row of rows) {
        const order = JSON.parse(row.data);
        updateCoordinates.run(Number.isFinite(order.latitude) ? order.latitude : null, Number.isFinite(order.longitude) ? order.longitude : null, Number.isFinite(order.distanceKm) ? order.distanceKm : null, row.id);
      }
    });
    backfillOrderCoordinates();
    connection.exec("CREATE INDEX IF NOT EXISTS orders_distance_km_idx ON orders (distance_km)");
    await importLegacyDatabase(connection);
    database = connection;
    console.log(`SQLite database initialized at ${databasePath}`);
  } catch (error) {
    connection.close();
    throw error;
  }
};

const getDatabase = () => {
  if (!database) throw new Error("SQLite database has not been initialized.");
  return database;
};

export const backupDatabase = (destination) => getDatabase().backup(destination);

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

const toProduct = ({ id, name, category, price, unit, description, emoji }) => ({ id, name, category, price, unit, description, emoji });

export const listProducts = ({ offset = 0, limit = 50 } = {}) => {
  const connection = getDatabase();
  const total = connection.prepare("SELECT COUNT(*) AS total FROM products").get().total;
  const products = connection.prepare("SELECT id, name, category, price, unit, description, emoji FROM products ORDER BY rowid ASC LIMIT ? OFFSET ?").all(limit, offset).map(toProduct);
  return { products, total };
};

export const listAdminProducts = ({ cursor, limit = 20 }) => {
  const connection = getDatabase();
  const rows = cursor === null || cursor === undefined ? connection.prepare("SELECT rowid AS cursor, id, name, category, price, unit, description, emoji FROM products ORDER BY rowid DESC LIMIT ?").all(limit + 1) : connection.prepare("SELECT rowid AS cursor, id, name, category, price, unit, description, emoji FROM products WHERE rowid < ? ORDER BY rowid DESC LIMIT ?").all(cursor, limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    products: pageRows.map(({ cursor: _cursor, ...product }) => toProduct(product)),
    nextCursor: hasMore ? pageRows[pageRows.length - 1].cursor : null,
    hasMore,
    total: countProducts(),
  };
};

export const countProducts = () => getDatabase().prepare("SELECT COUNT(*) AS total FROM products").get().total;

export const getAllProducts = () => getDatabase().prepare("SELECT id, name, category, price, unit, description, emoji FROM products ORDER BY rowid ASC").all().map(toProduct);

export const listProductCategories = () =>
  getDatabase()
    .prepare("SELECT DISTINCT category FROM products ORDER BY category COLLATE NOCASE")
    .all()
    .map(({ category }) => category);

export const saveProduct = ({ packSize, unitType, ...product }) => {
  const connection = getDatabase();
  const normalizedPackSize = String(packSize);
  const unitSlug = unitType.toLowerCase();
  const baseId = `${product.category}-${normalizedPackSize.replace(".", "-")}${unitSlug}`;
  const nameSlug =
    product.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "product";
  let id = baseId;
  let suffix = 1;
  while (connection.prepare("SELECT 1 FROM products WHERE id = ?").get(id)) {
    id = `${baseId}-${nameSlug}${suffix === 1 ? "" : `-${suffix}`}`;
    suffix += 1;
  }
  const savedProduct = { ...product, id, unit: `${normalizedPackSize} ${unitType}` };
  connection.prepare("INSERT INTO products (id, name, category, price, unit, description, emoji) VALUES (?, ?, ?, ?, ?, ?, ?)").run(savedProduct.id, savedProduct.name, savedProduct.category, savedProduct.price, savedProduct.unit, savedProduct.description, savedProduct.emoji);
  return savedProduct;
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
  getDatabase().prepare("INSERT INTO orders (id, status, created_at, data, latitude, longitude, distance_km) VALUES (?, ?, ?, ?, ?, ?, ?)").run(order.id, order.status, order.createdAt, JSON.stringify(order), order.latitude, order.longitude, order.distanceKm);
};

const getOrderConditions = ({ status, dateFrom, dateToExclusive, categoryProductIds, minDistanceKm, minDistanceInclusive, maxDistanceKm } = {}) => {
  const conditions = [];
  const parameters = [];
  if (status) {
    conditions.push("status = ?");
    parameters.push(status);
  }
  if (dateFrom) {
    conditions.push("created_at >= ?");
    parameters.push(dateFrom);
  }
  if (dateToExclusive) {
    conditions.push("created_at < ?");
    parameters.push(dateToExclusive);
  }
  if (categoryProductIds?.length) {
    conditions.push(`EXISTS (SELECT 1 FROM json_each(orders.data, '$.items') AS order_item WHERE json_extract(order_item.value, '$.productId') IN (${categoryProductIds.map(() => "?").join(", ")}))`);
    parameters.push(...categoryProductIds);
  }
  if (minDistanceKm !== undefined) {
    conditions.push(`distance_km ${minDistanceInclusive ? ">=" : ">"} ?`);
    parameters.push(minDistanceKm);
  }
  if (maxDistanceKm !== undefined) {
    conditions.push("distance_km <= ?");
    parameters.push(maxDistanceKm);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", parameters };
};

export const countOrders = (filters = {}) => {
  const connection = getDatabase();
  const { where, parameters } = getOrderConditions(filters);
  return connection.prepare(`SELECT COUNT(*) AS total FROM orders ${where}`).get(...parameters).total;
};

export const listOrders = ({ offset, limit, sortDate = "newest", ...filters }) => {
  const connection = getDatabase();
  const { where, parameters } = getOrderConditions(filters);
  const total = countOrders(filters);
  const rows = connection.prepare(`SELECT data, latitude, longitude FROM orders ${where} ORDER BY created_at ${sortDate === "oldest" ? "ASC" : "DESC"}, id ASC LIMIT ? OFFSET ?`).all(...parameters, limit, offset);
  const orders = rows.map((row) => ({ ...JSON.parse(row.data), latitude: row.latitude, longitude: row.longitude }));
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
