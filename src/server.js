import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { products } from "./products.js";
import { sendCustomerOrderConfirmationEmail, sendCustomerStatusEmail, sendOrderNotifications, sendTestEmail, sendVerificationEmail } from "./notifications.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const frontendOrigin = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
const verificationFrontendUrl = (process.env.NODE_ENV === "production" ? process.env.FRONTEND_URL_PROD || process.env.FRONTEND_URL : process.env.FRONTEND_URL || process.env.FRONTEND_URL_PROD || "http://localhost:5173").replace(/\/+$/, "");
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

const readLocalDatabase = async () => {
  await localDatabaseQueue;
  try {
    return JSON.parse(await readFile(localDatabasePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
};

const updateLocalDatabase = (update) => {
  const operation = localDatabaseQueue.then(async () => {
    let data = {};
    try {
      data = JSON.parse(await readFile(localDatabasePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const result = update(data);
    const temporaryPath = `${localDatabasePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
    await rename(temporaryPath, localDatabasePath);
    return result;
  });
  localDatabaseQueue = operation.catch(() => {});
  return operation;
};

const readLocalOrders = async () => {
  const data = await readLocalDatabase();
  return Array.isArray(data.orders) ? data.orders : [];
};

const updateLocalOrders = (update) =>
  updateLocalDatabase((data) => {
    data.orders = Array.isArray(data.orders) ? data.orders : [];
    return update(data.orders);
  });

const findVerifiedEmail = async (email) => {
  try {
    return Boolean(await (await getDatabase()).collection("verifiedEmails").findOne({ _id: email }));
  } catch {
    const data = await readLocalDatabase();
    return (data.verifiedEmails || []).some((entry) => (typeof entry === "string" ? entry : entry.email) === email);
  }
};

const readPendingVerification = async (email) => {
  try {
    return await (await getDatabase()).collection("pendingVerifications").findOne({ _id: email });
  } catch {
    const data = await readLocalDatabase();
    return (data.pendingVerifications || []).find((entry) => entry.email === email) || null;
  }
};

const savePendingVerification = async (record) => {
  try {
    await (await getDatabase()).collection("pendingVerifications").replaceOne({ _id: record.email }, { ...record, _id: record.email }, { upsert: true });
  } catch (error) {
    console.error("MongoDB verification save failed; using db.json:", error);
    await updateLocalDatabase((data) => {
      data.pendingVerifications = Array.isArray(data.pendingVerifications) ? data.pendingVerifications : [];
      data.pendingVerifications = data.pendingVerifications.filter((entry) => entry.email !== record.email);
      data.pendingVerifications.push(record);
    });
  }
};

const completeEmailVerification = async (email, nonce) => {
  try {
    const database = await getDatabase();
    const pending = database.collection("pendingVerifications");
    const record = await pending.findOne({ _id: email, nonce, expiresAt: { $gt: Date.now() } });
    if (!record) return null;
    await database.collection("verifiedEmails").updateOne({ _id: email }, { $setOnInsert: { email, verifiedAt: new Date().toISOString() } }, { upsert: true });
    await pending.deleteOne({ _id: email });
    return record.checkout;
  } catch (error) {
    console.error("MongoDB email verification failed; using db.json:", error);
    let checkout = null;
    await updateLocalDatabase((data) => {
      data.verifiedEmails = Array.isArray(data.verifiedEmails) ? data.verifiedEmails : [];
      data.pendingVerifications = Array.isArray(data.pendingVerifications) ? data.pendingVerifications : [];
      const record = data.pendingVerifications.find((entry) => entry.email === email && entry.nonce === nonce && entry.expiresAt > Date.now());
      if (!record) return;
      checkout = record.checkout || null;
      if (!data.verifiedEmails.some((entry) => (typeof entry === "string" ? entry : entry.email) === email)) {
        data.verifiedEmails.push({ email, verifiedAt: new Date().toISOString() });
      }
      data.pendingVerifications = data.pendingVerifications.filter((entry) => entry.email !== email);
    });
    return checkout;
  }
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
const emailVerificationSecret = () => process.env.EMAIL_VERIFICATION_SECRET || process.env.ADMIN_SESSION_SECRET;
const createEmailVerificationToken = (email, nonce) => {
  const secret = emailVerificationSecret();
  if (!secret) throw new Error("EMAIL_VERIFICATION_SECRET or ADMIN_SESSION_SECRET must be configured.");
  const payload = Buffer.from(JSON.stringify({ email, expiresAt: Date.now() + 30 * 60 * 1000, nonce })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};
const getVerifiedEmail = (token) => {
  const secret = emailVerificationSecret();
  if (!secret || typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.email === "string" && typeof claims.nonce === "string" && claims.expiresAt > Date.now() ? claims : null;
  } catch {
    return null;
  }
};
const requireOwner = (request, response, next) => {
  if (!validSession(request.cookies[sessionCookie])) return response.status(401).json({ error: "Authentication required." });
  next();
};

const documentedOperations = {
  "GET /health": { tag: "Health", summary: "Check backend health" },
  "GET /api/products": {
    tag: "Products",
    summary: "List products",
    parameters: [
      { name: "page", in: "query", schema: { type: "integer", minimum: 1 }, description: "Page number (default: 1)." },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 }, description: "Results per page (default: 6, maximum: 50)." },
    ],
  },
  "POST /api/auth/login": {
    tag: "Authentication",
    summary: "Log in as the owner",
    description: "Successful login sets the owner session cookie used by protected endpoints.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", required: ["username", "password"], properties: { username: { type: "string" }, password: { type: "string", format: "password" } } },
          example: { username: "your-admin-username", password: "your-admin-password" },
        },
      },
    },
  },
  "POST /api/auth/logout": { tag: "Authentication", summary: "Log out the owner" },
  "POST /api/email/test": { tag: "Email", summary: "Send a test email", description: "Sends a test message to OWNER_EMAIL. Requires an owner session.", authenticated: true },
  "POST /api/email/status": {
    tag: "Email",
    summary: "Check whether a customer email is verified",
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } } },
    },
  },
  "POST /api/email/verification": {
    tag: "Email",
    summary: "Send a customer email verification link",
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } } },
    },
  },
  "POST /api/email/verify": {
    tag: "Email",
    summary: "Verify a customer email token",
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } },
    },
  },
  "POST /api/orders": {
    tag: "Orders",
    summary: "Place an order",
    description: "Creates a real order and may send configured notifications.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["customerName", "email", "verificationToken", "phone", "address", "city", "pincode", "latitude", "longitude", "items"],
            properties: {
              customerName: { type: "string" },
              email: { type: "string", format: "email" },
              verificationToken: { type: "string" },
              phone: { type: "string" },
              address: { type: "string" },
              city: { type: "string" },
              pincode: { type: "string" },
              notes: { type: "string" },
              latitude: { type: "number" },
              longitude: { type: "number" },
              items: { type: "array", minItems: 1, items: { type: "object", required: ["productId", "quantity"], properties: { productId: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 99 } } } },
            },
          },
          example: {
            customerName: "Test Customer",
            phone: "9999999999",
            address: "1 Example Road",
            city: "New Delhi",
            pincode: "110001",
            notes: "Swagger test order",
            latitude: 28.6139,
            longitude: 77.209,
            items: [{ productId: "milk-1l-cow", quantity: 1 }],
          },
        },
      },
    },
  },
  "GET /api/orders": {
    tag: "Orders",
    summary: "List orders",
    authenticated: true,
    parameters: [
      { name: "page", in: "query", schema: { type: "integer", minimum: 1 }, description: "Page number (default: 1)." },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 }, description: "Results per page (default: 8, maximum: 50)." },
    ],
  },
  "PUT /api/orders/:id/status": {
    tag: "Orders",
    summary: "Update an order status",
    authenticated: true,
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: statuses } } },
          example: { status: "placed" },
        },
      },
    },
  },
};

const createOpenApiDocument = () => {
  const paths = {};
  const supportedMethods = new Set(["get", "post", "put", "patch", "delete"]);

  app._router.stack.forEach((layer) => {
    if (!layer.route || typeof layer.route.path !== "string" || layer.route.path.startsWith("/api/docs")) return;
    const routePath = layer.route.path;
    const openApiPath = routePath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    paths[openApiPath] ||= {};

    Object.keys(layer.route.methods).forEach((method) => {
      if (!supportedMethods.has(method)) return;
      const operation = documentedOperations[`${method.toUpperCase()} ${routePath}`] || {};
      const pathParameters = [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map(([, name]) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
      paths[openApiPath][method] = {
        tags: [operation.tag || "API"],
        summary: operation.summary || `${method.toUpperCase()} ${routePath}`,
        ...(operation.description ? { description: operation.description } : {}),
        ...(operation.authenticated ? { security: [{ OwnerSession: [] }] } : {}),
        ...(operation.parameters || pathParameters.length ? { parameters: [...pathParameters, ...(operation.parameters || [])] } : {}),
        ...(operation.requestBody ? { requestBody: operation.requestBody } : {}),
        responses: {
          200: { description: "Request completed successfully." },
          400: { description: "Invalid request." },
          401: { description: "Owner authentication required or credentials are invalid." },
          500: { description: "Server error." },
        },
      };
    });
  });

  return {
    openapi: "3.0.3",
    info: { title: "Milk Villa API", version: "1.0.0", description: "API routes are discovered from the running Express application." },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        OwnerSession: { type: "apiKey", in: "cookie", name: sessionCookie, description: "Set automatically after a successful owner login." },
      },
    },
  };
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

app.post("/api/email/test", requireOwner, async (_request, response) => {
  try {
    await sendTestEmail();
    return response.json({ ok: true, message: `Test email sent to ${process.env.OWNER_EMAIL}.` });
  } catch (error) {
    console.error("Test email failed:", error);
    return response.status(500).json({ error: error.message || "Test email could not be sent." });
  }
});

app.post("/api/email/status", async (request, response) => {
  const email = String(request.body?.email || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: "Enter a valid email address." });
  try {
    return response.json({ email, verified: await findVerifiedEmail(email) });
  } catch (error) {
    console.error("Email verification status lookup failed:", error);
    return response.status(500).json({ error: "Email verification status could not be checked." });
  }
});

app.post("/api/email/verification", async (request, response) => {
  const email = String(request.body?.email || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: "Enter a valid email address." });
  try {
    if (await findVerifiedEmail(email)) return response.json({ ok: true, verified: true, email, message: "This email is already verified." });
    const pending = await readPendingVerification(email);
    const retryAfter = pending ? Math.ceil((pending.lastSentAt + 30_000 - Date.now()) / 1000) : 0;
    if (retryAfter > 0) {
      response.set("Retry-After", String(retryAfter));
      return response.status(429).json({ error: `Please wait ${retryAfter} seconds before requesting another link.`, retryAfter });
    }

    const submittedCheckout = request.body?.checkout || {};
    const submittedForm = submittedCheckout.form || {};
    const form = Object.fromEntries(["customerName", "email", "phone", "address", "city", "pincode", "notes"].map((field) => [field, String(submittedForm[field] || "").slice(0, 1000)]));
    form.email = email;
    const catalog = new Map(products.map((product) => [product.id, product]));
    const items = (Array.isArray(submittedCheckout.items) ? submittedCheckout.items : []).flatMap((item) => {
      const product = catalog.get(item.productId);
      const quantity = Number(item.quantity);
      return product && Number.isInteger(quantity) && quantity > 0 && quantity <= 99 ? [{ ...product, quantity, total: product.price * quantity }] : [];
    });
    const submittedPosition = submittedCheckout.position;
    const position = submittedPosition && Number.isFinite(Number(submittedPosition.latitude)) && Number.isFinite(Number(submittedPosition.longitude)) ? { latitude: Number(submittedPosition.latitude), longitude: Number(submittedPosition.longitude) } : null;
    const checkout = { form, items, position };
    const nonce = randomBytes(16).toString("hex");
    const token = createEmailVerificationToken(email, nonce);
    const verificationUrl = `${verificationFrontendUrl}/?verify=${encodeURIComponent(token)}`;
    await sendVerificationEmail(email, verificationUrl);
    await savePendingVerification({ email, nonce, checkout, expiresAt: Date.now() + 30 * 60 * 1000, lastSentAt: Date.now() });
    return response.json({ ok: true, verified: false, retryAfter: 30, message: `Verification link sent to ${email}.` });
  } catch (error) {
    console.error("Email verification link failed:", error);
    return response.status(503).json({ error: error.message || "Verification email could not be sent." });
  }
});

app.post("/api/email/verify", async (request, response) => {
  const claims = getVerifiedEmail(request.body?.token);
  if (!claims) return response.status(400).json({ error: "This verification link is invalid or has expired. Request a new link." });
  try {
    const checkout = await completeEmailVerification(claims.email, claims.nonce);
    if (!checkout && !(await findVerifiedEmail(claims.email))) return response.status(400).json({ error: "This verification link is invalid or has expired. Request a new link." });
    return response.json({ email: claims.email, verificationToken: request.body.token, checkout, verified: true });
  } catch (error) {
    console.error("Email verification failed:", error);
    return response.status(500).json({ error: "Email verification could not be saved. Please try again." });
  }
});

app.post("/api/orders", async (request, response) => {
  try {
    const { customerName, email, verificationToken, phone, address, city, pincode, notes = "", latitude, longitude, items } = request.body || {};
    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();
    if (!customerName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || !phone || !address || !city || !pincode || !Array.isArray(items) || items.length === 0 || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return response.status(400).json({ error: "Complete customer details, a valid email, location, and at least one item are required." });
    if (getVerifiedEmail(verificationToken)?.email !== normalizedEmail && !(await findVerifiedEmail(normalizedEmail))) return response.status(403).json({ error: "Verify your email before placing this order." });
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
      email: normalizedEmail,
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
    let customerEmail = { sent: false };
    try {
      await sendCustomerOrderConfirmationEmail(order);
      customerEmail = { sent: true };
    } catch (notificationError) {
      console.error("Customer order confirmation email failed:", notificationError);
      customerEmail.warning = notificationError.message || "Confirmation email could not be sent.";
    }
    try {
      await sendOrderNotifications(order);
    } catch (notificationError) {
      console.error("Order notification failed:", notificationError);
    }
    return response.status(201).json({ order, customerEmail });
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
  let updatedOrder;
  let previousStatus;
  try {
    const collection = (await getDatabase()).collection("orders");
    const currentOrder = await collection.findOne({ id: request.params.id });
    if (!currentOrder) return response.status(404).json({ error: "Order not found." });
    if (currentOrder.status === "delivered") return response.status(409).json({ error: "Delivered orders cannot be changed." });
    if (currentOrder.status === status) return response.json({ order: currentOrder, notification: { sent: true, skipped: true } });
    previousStatus = currentOrder.status;
    const result = await collection.findOneAndUpdate({ id: request.params.id, status: { $ne: "delivered" } }, { $set: { status } }, { returnDocument: "after" });
    if (!result) return response.status(409).json({ error: "Delivered orders cannot be changed." });
    updatedOrder = result;
  } catch (error) {
    console.error("MongoDB order update failed; using db.json:", error);
    try {
      const result = await updateLocalOrders((orders) => {
        const matchingOrder = orders.find((entry) => entry.id === request.params.id);
        if (!matchingOrder) return { status: 404, error: "Order not found." };
        if (matchingOrder.status === "delivered") return { status: 409, error: "Delivered orders cannot be changed." };
        if (matchingOrder.status === status) return { order: matchingOrder, skipped: true };
        previousStatus = matchingOrder.status;
        matchingOrder.status = status;
        return { order: matchingOrder };
      });
      if (result.error) return response.status(result.status).json({ error: result.error });
      updatedOrder = result.order;
      if (result.skipped) return response.json({ order: updatedOrder, notification: { sent: true, skipped: true } });
    } catch (localError) {
      return response.status(500).json({ error: localError.message });
    }
  }
  try {
    if (!updatedOrder.email) throw new Error("This order has no customer email address.");
    await sendCustomerStatusEmail(updatedOrder);
    return response.json({ order: updatedOrder, notification: { sent: true } });
  } catch (notificationError) {
    console.error("Customer status email failed:", notificationError);
    return response.json({ order: updatedOrder, notification: { sent: false, warning: notificationError.message || "Customer email could not be sent." }, previousStatus });
  }
});

app.get("/api/docs/openapi.json", (_request, response) => response.json(createOpenApiDocument()));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(null, { swaggerOptions: { url: "/api/docs/openapi.json", withCredentials: true } }));

app.listen(port, () => console.log(`Milk Villa API listening on port ${port}`));
