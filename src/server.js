import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { products } from "./products.js";
import { sendOrderNotifications } from "./notifications.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const frontendOrigin = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
const sessionCookie = "milk-villa-owner-session";
const sessionDurationMs = 8 * 60 * 60 * 1000;
const statuses = ["pending", "placed", "out-for-delivery", "delivered"];
const client = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI) : null;
const localDatabasePath = resolve(dirname(fileURLToPath(import.meta.url)), "../db.json");
let database;
let localDatabaseQueue = Promise.resolve();

app.use(cors({ origin: frontendOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const getDatabase = async () => {
  if (!client) throw new Error("MONGODB_URI is not configured.");
  if (!database) {
    await client.connect();
    database = client.db(process.env.MONGODB_DB || "milkVilla");
  }
  return database;
};

const getPagination = (query, total, defaultLimit) => {
  const requestedPage = Number.parseInt(query.page, 10);
  const requestedLimit = Number.parseInt(query.limit, 10);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : defaultLimit;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, totalPages);
  return { page, limit, total, totalPages, offset: (page - 1) * limit };
};

const countOrderStatuses = (orders) =>
  orders.reduce(
    (counts, order) => {
      if (statuses.includes(order.status)) counts[order.status] += 1;
      return counts;
    },
    Object.fromEntries(statuses.map((status) => [status, 0])),
  );

const readLocalOrders = async () => {
  await localDatabaseQueue;
  try {
    const data = JSON.parse(await readFile(localDatabasePath, "utf8"));
    return Array.isArray(data.orders) ? data.orders : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

const updateLocalOrders = (update) => {
  const operation = localDatabaseQueue.then(async () => {
    let orders = [];
    try {
      const data = JSON.parse(await readFile(localDatabasePath, "utf8"));
      orders = Array.isArray(data.orders) ? data.orders : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const result = update(orders);
    const temporaryPath = `${localDatabasePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ orders }, null, 2)}\n`);
    await rename(temporaryPath, localDatabasePath);
    return result;
  });
  localDatabaseQueue = operation.catch(() => {});
  return operation;
};

const distanceKm = (latitude, longitude) => {
  const dairyLatitude = Number(process.env.DAIRY_LATITUDE);
  const dairyLongitude = Number(process.env.DAIRY_LONGITUDE);
  if (![latitude, longitude, dairyLatitude, dairyLongitude].every(Number.isFinite)) throw new Error("Dairy coordinates are not configured.");
  const radians = (value) => (value * Math.PI) / 180;
  const a = Math.sin(radians(dairyLatitude - latitude) / 2) ** 2 + Math.sin(radians(dairyLongitude - longitude) / 2) ** 2 * Math.cos(radians(latitude)) * Math.cos(radians(dairyLatitude));
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const sign = (value) =>
  createHmac("sha256", process.env.ADMIN_SESSION_SECRET || "development-secret")
    .update(value)
    .digest("base64url");
const createSession = (username) => {
  const value = `${username}.${Date.now()}`;
  return `${value}.${sign(value)}`;
};
const validSession = (token) => {
  if (!token) return false;
  const [username, timestamp, signature] = token.split(".");
  const issuedAt = Number(timestamp);
  if (!username || !signature || !Number.isFinite(issuedAt) || Date.now() - issuedAt > sessionDurationMs || issuedAt > Date.now()) return false;
  const expected = Buffer.from(sign(`${username}.${timestamp}`));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const requireOwner = (request, response, next) => {
  if (!validSession(request.cookies[sessionCookie])) return response.status(401).json({ error: "Authentication required." });
  next();
};

app.get("/health", (_request, response) => response.json({ ok: true, service: "milk-villa-backend" }));
app.get("/api/products", (request, response) => {
  const pagination = getPagination(request.query, products.length, 6);
  response.json({
    products: products.slice(pagination.offset, pagination.offset + pagination.limit),
    pagination: { page: pagination.page, limit: pagination.limit, total: pagination.total, totalPages: pagination.totalPages },
  });
});

app.post("/api/auth/login", (request, response) => {
  const { username, password } = request.body || {};
  if (!username || !password || username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) return response.status(401).json({ error: "Invalid username or password." });
  response.cookie(sessionCookie, createSession(username), { httpOnly: true, sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", secure: process.env.NODE_ENV === "production", maxAge: sessionDurationMs, path: "/" });
  return response.json({ ok: true });
});
app.post("/api/auth/logout", (_request, response) => {
  response.clearCookie(sessionCookie, { httpOnly: true, sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  response.json({ ok: true });
});

app.post("/api/orders", async (request, response) => {
  try {
    const { customerName, phone, address, city, pincode, notes = "", latitude, longitude, items } = request.body || {};
    if (!customerName || !phone || !address || !city || !pincode || !Array.isArray(items) || items.length === 0 || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return response.status(400).json({ error: "Complete customer details, location, and at least one item are required." });
    const catalog = new Map(products.map((product) => [product.id, product]));
    const normalizedItems = items.map((item) => {
      const product = catalog.get(item.productId);
      const quantity = Number(item.quantity);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("Invalid product or quantity.");
      return { productId: product.id, name: product.name, quantity, price: product.price, total: product.price * quantity };
    });
    const subtotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
    const calculatedDistance = Number(distanceKm(Number(latitude), Number(longitude)).toFixed(2));
    const deliveryFee = calculatedDistance > 10 ? 40 : 0;
    const order = {
      id: `MV-${Date.now()}`,
      customerName: String(customerName).trim(),
      phone: String(phone).trim(),
      address: String(address).trim(),
      city: String(city).trim(),
      pincode: String(pincode).trim(),
      notes: String(notes).trim(),
      latitude: Number(latitude),
      longitude: Number(longitude),
      distanceKm: calculatedDistance,
      items: normalizedItems,
      subtotal,
      deliveryFee,
      total: subtotal + deliveryFee,
      paymentMethod: "cash-on-delivery",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    try {
      const collection = (await getDatabase()).collection("orders");
      await collection.insertOne(order);
    } catch (databaseError) {
      console.error("MongoDB order save failed; using db.json:", databaseError);
      await updateLocalOrders((orders) => orders.unshift(order));
    }
    try {
      await sendOrderNotifications(order);
    } catch (notificationError) {
      console.error("Order notification failed:", notificationError);
    }
    return response.status(201).json({ order });
  } catch (error) {
    console.error(error);
    return response.status(400).json({ error: error.message || "Order could not be placed." });
  }
});

app.get("/api/orders", requireOwner, async (request, response) => {
  try {
    const collection = (await getDatabase()).collection("orders");
    const total = await collection.countDocuments({});
    const pagination = getPagination(request.query, total, 8);
    const [orders, statusRows] = await Promise.all([collection.find({}).sort({ createdAt: -1 }).skip(pagination.offset).limit(pagination.limit).toArray(), collection.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray()]);
    const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
    statusRows.forEach(({ _id, count }) => {
      if (statuses.includes(_id)) counts[_id] = count;
    });
    response.json({
      orders,
      pagination: { page: pagination.page, limit: pagination.limit, total: pagination.total, totalPages: pagination.totalPages },
      counts,
    });
  } catch (error) {
    console.error("MongoDB order load failed; using db.json:", error);
    try {
      const allOrders = (await readLocalOrders()).sort((first, second) => second.createdAt.localeCompare(first.createdAt));
      const pagination = getPagination(request.query, allOrders.length, 8);
      response.json({
        orders: allOrders.slice(pagination.offset, pagination.offset + pagination.limit),
        pagination: { page: pagination.page, limit: pagination.limit, total: pagination.total, totalPages: pagination.totalPages },
        counts: countOrderStatuses(allOrders),
      });
    } catch (localError) {
      response.status(500).json({ error: localError.message });
    }
  }
});

app.put("/api/orders/:id/status", requireOwner, async (request, response) => {
  const { status } = request.body || {};
  if (!statuses.includes(status)) return response.status(400).json({ error: "Invalid order status." });
  try {
    const collection = (await getDatabase()).collection("orders");
    const currentOrder = await collection.findOne({ id: request.params.id });
    if (!currentOrder) return response.status(404).json({ error: "Order not found." });
    if (currentOrder.status === "delivered") return response.status(409).json({ error: "Delivered orders cannot be changed." });
    const result = await collection.findOneAndUpdate({ id: request.params.id, status: { $ne: "delivered" } }, { $set: { status } }, { returnDocument: "after" });
    if (!result) return response.status(409).json({ error: "Delivered orders cannot be changed." });
    return response.json({ order: result });
  } catch (error) {
    console.error("MongoDB order update failed; using db.json:", error);
    try {
      const result = await updateLocalOrders((orders) => {
        const matchingOrder = orders.find((entry) => entry.id === request.params.id);
        if (!matchingOrder) return { status: 404, error: "Order not found." };
        if (matchingOrder.status === "delivered") return { status: 409, error: "Delivered orders cannot be changed." };
        matchingOrder.status = status;
        return { order: matchingOrder };
      });
      if (result.error) return response.status(result.status).json({ error: result.error });
      return response.json({ order: result.order });
    } catch (localError) {
      return response.status(500).json({ error: localError.message });
    }
  }
});

app.listen(port, () => console.log(`Milk Villa API listening on port ${port}`));
