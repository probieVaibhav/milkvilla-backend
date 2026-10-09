import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { Prisma, PrismaClient } from "@prisma/client";
import { fileURLToPath } from "node:url";
import { getMongoConnectionUrl } from "../src/mongo-url.js";

const defaultSqlitePath = fileURLToPath(new URL("../milk-villa.sqlite", import.meta.url));
const sqlitePath = process.env.SQLITE_DB_PATH || defaultSqlitePath;
const dryRun = process.argv.includes("--dry-run");

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const prisma = dryRun ? null : new PrismaClient({ datasources: { db: { url: getMongoConnectionUrl() } } });
let imported = { products: 0, orders: 0, verifiedEmails: 0, pendingVerifications: 0 };
let connected = false;

const parseJson = (value, label) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Cannot parse ${label} from the SQLite database.`, { cause: error });
  }
};

try {
  if (!dryRun) {
    await prisma.$connect();
    connected = true;
  }

  const products = sqlite.prepare("SELECT rowid, id, name, category, price, unit, description, emoji FROM products ORDER BY rowid").all();
  for (const product of products) {
    if (!dryRun) {
      await prisma.product.upsert({
        where: { id: product.id },
        create: {
          id: product.id,
          name: product.name,
          category: product.category,
          price: product.price,
          unit: product.unit,
          description: product.description,
          emoji: product.emoji,
          sortOrder: product.rowid,
        },
        update: {
          name: product.name,
          category: product.category,
          price: product.price,
          unit: product.unit,
          description: product.description,
          emoji: product.emoji,
          sortOrder: product.rowid,
        },
      });
    }
    imported.products += 1;
  }

  const orders = sqlite.prepare("SELECT id, status, created_at, data, latitude, longitude, distance_km FROM orders ORDER BY created_at, id").all();
  for (const row of orders) {
    const order = parseJson(row.data, `order ${row.id}`);
    const requiredTextFields = ["customerName", "phone", "address", "city", "pincode", "paymentMethod"];
    const hasRequiredText = requiredTextFields.every((field) => typeof order?.[field] === "string");
    const hasValidTotals = ["subtotal", "deliveryFee", "total"].every((field) => Number.isFinite(order?.[field]));
    const hasValidItems = Array.isArray(order?.items) && order.items.every((item) => typeof item?.productId === "string");
    if (!order?.id || !row.status || !hasRequiredText || !hasValidTotals || !hasValidItems || !row.created_at) {
      throw new Error(`Order ${row.id} is missing fields required by the MongoDB order schema.`);
    }
    const createdAt = new Date(order.createdAt || row.created_at);
    if (!Number.isFinite(createdAt.getTime())) throw new Error(`Order ${row.id} has an invalid creation date.`);
    const data = {
      id: order.id,
      status: row.status,
      createdAt,
      customerName: order.customerName,
      email: order.email ?? null,
      phone: order.phone,
      address: order.address,
      city: order.city,
      pincode: order.pincode,
      notes: order.notes ?? null,
      latitude: Number.isFinite(row.latitude) ? row.latitude : order.latitude ?? null,
      longitude: Number.isFinite(row.longitude) ? row.longitude : order.longitude ?? null,
      distanceKm: Number.isFinite(row.distance_km) ? row.distance_km : order.distanceKm ?? null,
      items: order.items,
      productIds: order.items.map(({ productId }) => productId),
      subtotal: order.subtotal,
      deliveryFee: order.deliveryFee,
      total: order.total,
      paymentMethod: order.paymentMethod,
      cancellationReason: order.cancellationReason ?? null,
    };
    if (!dryRun) {
      const { id: _id, ...update } = data;
      await prisma.order.upsert({ where: { id: order.id }, create: data, update });
    }
    imported.orders += 1;
  }

  const verifiedEmails = sqlite.prepare("SELECT email, verified_at FROM verified_emails").all();
  for (const record of verifiedEmails) {
    const verifiedAt = new Date(record.verified_at);
    if (!Number.isFinite(verifiedAt.getTime())) throw new Error("A verified email has an invalid verification date.");
    if (!dryRun) {
      await prisma.emailVerification.upsert({
        where: { email: record.email },
        create: { email: record.email, verifiedAt },
        update: { verifiedAt },
      });
    }
    imported.verifiedEmails += 1;
  }

  const pendingVerifications = sqlite.prepare("SELECT email, nonce, expires_at, last_sent_at, checkout FROM pending_verifications").all();
  for (const record of pendingVerifications) {
    const checkout = parseJson(record.checkout, `pending verification for ${record.email}`);
    const data = {
      nonce: record.nonce,
      expiresAt: record.expires_at,
      lastSentAt: record.last_sent_at,
      checkout: checkout === null ? Prisma.JsonNull : checkout,
    };
    if (!dryRun) {
      await prisma.emailVerification.upsert({
        where: { email: record.email },
        create: { email: record.email, ...data },
        update: data,
      });
    }
    imported.pendingVerifications += 1;
  }

  const action = dryRun ? "SQLite migration dry run validated" : "SQLite data copied to MongoDB";
  console.log(`${action}: ${JSON.stringify(imported)}. The source SQLite file was not modified.`);
} finally {
  sqlite.close();
  if (connected) await prisma.$disconnect();
}
