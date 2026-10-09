import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { completeEmailVerification, countOrders, countProducts, findVerifiedEmail, getAllProducts, initializeDatabase, listAdminProducts, listOrders, listProductCategories, listProducts, readPendingVerification, saveOrder, savePendingVerification, saveProduct, updateOrderStatus } from "./database.js";
import { sendCustomerOrderConfirmationEmail, sendCustomerStatusEmail, sendOrderNotifications, sendTestEmail, sendVerificationEmail } from "./notifications.js";
import { checkoutEmailSchema, checkoutOrderSchema } from "./validation/checkout.js";
import { productInputSchema } from "./validation/product.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const frontendOrigin = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
const verificationFrontendUrl = (process.env.NODE_ENV === "production" ? process.env.FRONTEND_URL_PROD || process.env.FRONTEND_URL : process.env.FRONTEND_URL || process.env.FRONTEND_URL_PROD || "http://localhost:5173").replace(/\/+$/, "");
const sessionCookie = "milk-villa-owner-session";
const sessionDurationMs = 8 * 60 * 60 * 1000;
const statuses = ["pending", "placed", "out-for-delivery", "delivered", "canceled"];
const adminEventClients = new Set();

const parseDateFilter = (value) => {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
};

const nextDate = (date) => new Date(`${date}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000;

const distanceBands = {
  "1-10": { minDistanceKm: 1, minDistanceInclusive: true, maxDistanceKm: 10 },
  "10-20": { minDistanceKm: 10, maxDistanceKm: 20 },
  "20-50": { minDistanceKm: 20, maxDistanceKm: 50 },
  "50+": { minDistanceKm: 50 },
};

const publishAdminEvent = (eventName, payload) => {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of adminEventClients) {
    if (client.destroyed || client.writableEnded) {
      adminEventClients.delete(client);
      continue;
    }
    try {
      client.write(message);
    } catch {
      adminEventClients.delete(client);
    }
  }
};

app.use(cors({ origin: frontendOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const getPagination = (query, total, defaultLimit) => {
  const requestedPage = Number.parseInt(query.page, 10);
  const requestedLimit = Number.parseInt(query.limit, 10);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : defaultLimit;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, totalPages);
  return { page, limit, total, totalPages, offset: (page - 1) * limit };
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
  "GET /api/products/categories": { tag: "Products", summary: "List product types" },
  "GET /api/admin/products": {
    tag: "Products",
    summary: "List products for the owner",
    authenticated: true,
    parameters: [
      { name: "cursor", in: "query", schema: { type: "integer", minimum: 1 }, description: "Product row cursor for the next page." },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 }, description: "Number of products per cursor page (default: 20)." },
    ],
  },
  "POST /api/admin/products": {
    tag: "Products",
    summary: "Add a product",
    authenticated: true,
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name", "category", "price", "packSize", "unitType", "description", "emoji"],
            properties: {
              name: { type: "string" },
              category: { type: "string" },
              price: { type: "number", exclusiveMinimum: 0 },
              packSize: { type: "number", exclusiveMinimum: 0 },
              unitType: { type: "string", enum: ["L", "KG", "G"] },
              description: { type: "string" },
              emoji: { type: "string" },
            },
          },
        },
      },
    },
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
      { name: "status", in: "query", schema: { type: "string", enum: statuses }, description: "Filter orders by status." },
      { name: "dateFrom", in: "query", schema: { type: "string", format: "date" }, description: "Include orders placed on or after this date (UTC)." },
      { name: "dateTo", in: "query", schema: { type: "string", format: "date" }, description: "Include orders placed on or before this date (UTC)." },
      { name: "category", in: "query", schema: { type: "string" }, description: "Filter by product type in the order." },
      { name: "distance", in: "query", schema: { type: "string", enum: Object.keys(distanceBands) }, description: "Filter by delivery distance in kilometers." },
      { name: "sortDate", in: "query", schema: { type: "string", enum: ["newest", "oldest"], default: "newest" }, description: "Sort orders by creation date." },
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
          schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: statuses }, cancellationReason: { type: "string", maxLength: 1000 } } },
          example: { status: "canceled", cancellationReason: "Canceled because one or more items are not in stock." },
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
  const total = countProducts();
  const pagination = getPagination(request.query, total, 6);
  const result = listProducts(pagination);
  response.json({
    products: result.products,
    pagination: { page: pagination.page, limit: pagination.limit, total: pagination.total, totalPages: pagination.totalPages },
  });
});
app.get("/api/products/categories", (_request, response) => response.json({ categories: listProductCategories() }));
app.get("/api/admin/products", requireOwner, (request, response) => {
  const requestedLimit = request.query.limit === undefined ? 20 : Number(request.query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) return response.status(400).json({ error: "Product page limit must be an integer from 1 to 50." });
  let cursor = null;
  if (request.query.cursor !== undefined) {
    cursor = Number(request.query.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 1) return response.status(400).json({ error: "Product cursor must be a positive integer." });
  }
  try {
    return response.json(listAdminProducts({ cursor, limit: requestedLimit }));
  } catch (error) {
    console.error("SQLite admin product load failed:", error);
    return response.status(500).json({ error: "Products could not be loaded." });
  }
});
app.post("/api/admin/products", requireOwner, (request, response) => {
  const validation = productInputSchema.safeParse(request.body || {});
  if (!validation.success) {
    return response.status(400).json({
      error: "Please correct the product details and try again.",
      fieldErrors: Object.fromEntries(validation.error.issues.map(({ path, message }) => [path[0], message])),
    });
  }
  try {
    const product = saveProduct(validation.data);
    return response.status(201).json({ product });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return response.status(409).json({ error: "A unique product ID could not be generated. Change the product type or pack size and try again." });
    }
    console.error("SQLite product save failed:", error);
    return response.status(500).json({ error: "Product could not be saved." });
  }
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
  const emailValidation = checkoutEmailSchema.safeParse(request.body?.email);
  if (!emailValidation.success) return response.status(400).json({ error: emailValidation.error.issues[0]?.message || "Enter a valid email address." });
  const email = emailValidation.data;
  try {
    return response.json({ email, verified: await findVerifiedEmail(email) });
  } catch (error) {
    console.error("Email verification status lookup failed:", error);
    return response.status(500).json({ error: "Email verification status could not be checked." });
  }
});

app.post("/api/email/verification", async (request, response) => {
  const emailValidation = checkoutEmailSchema.safeParse(request.body?.email);
  if (!emailValidation.success) return response.status(400).json({ error: emailValidation.error.issues[0]?.message || "Enter a valid email address." });
  const email = emailValidation.data;
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
    const catalog = new Map(getAllProducts().map((product) => [product.id, product]));
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
    const validation = checkoutOrderSchema.safeParse(request.body || {});
    if (!validation.success) {
      return response.status(400).json({
        error: "Please check the customer details, delivery location, and order items.",
        fieldErrors: validation.error.flatten().fieldErrors,
      });
    }
    const { customerName, email: normalizedEmail, verificationToken, phone, address, city, pincode, notes, latitude, longitude, items } = validation.data;
    if (getVerifiedEmail(verificationToken)?.email !== normalizedEmail && !(await findVerifiedEmail(normalizedEmail))) return response.status(403).json({ error: "Verify your email before placing this order." });
    const catalog = new Map(getAllProducts().map((product) => [product.id, product]));
    const normalizedItems = items.map((item) => {
      const product = catalog.get(item.productId);
      if (!product) throw new Error("One or more selected products are no longer available.");
      return { productId: product.id, name: product.name, category: product.category, quantity: item.quantity, price: product.price, total: product.price * item.quantity };
    });
    const subtotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
    const calculatedDistance = Number(distanceKm(latitude, longitude).toFixed(2));
    const deliveryFee = calculatedDistance > 10 ? 40 : 0;
    const order = {
      id: `MV-${Date.now()}`,
      customerName,
      email: normalizedEmail,
      phone,
      address,
      city,
      pincode,
      notes,
      latitude,
      longitude,
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
      saveOrder(order);
    } catch (databaseError) {
      console.error("SQLite order save failed:", databaseError);
      return response.status(500).json({ error: "Order could not be saved." });
    }
    publishAdminEvent("order-created", { orderId: order.id });
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

app.get("/api/admin/order-events", requireOwner, (request, response) => {
  response.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  response.write("retry: 5000\n: connected\n\n");
  adminEventClients.add(response);
  response.on("close", () => adminEventClients.delete(response));
});

app.get("/api/orders", requireOwner, async (request, response) => {
  try {
    const status = request.query.status;
    if (status && !statuses.includes(status)) return response.status(400).json({ error: "Invalid order status filter." });
    const dateFrom = parseDateFilter(request.query.dateFrom);
    const dateTo = parseDateFilter(request.query.dateTo);
    if (dateFrom === undefined || dateTo === undefined) return response.status(400).json({ error: "Dates must be valid calendar dates in YYYY-MM-DD format." });
    if (dateFrom && dateTo && dateFrom > dateTo) return response.status(400).json({ error: "The start date must be on or before the end date." });

    const category = request.query.category;
    if (category && !listProductCategories().includes(category)) return response.status(400).json({ error: "Invalid product category filter." });
    const distance = request.query.distance;
    if (distance && !distanceBands[distance]) return response.status(400).json({ error: "Invalid delivery distance filter." });
    const sortDate = request.query.sortDate || "newest";
    if (!["newest", "oldest"].includes(sortDate)) return response.status(400).json({ error: "Invalid order date sort." });

    const filters = {
      status,
      dateFrom: dateFrom ? `${dateFrom}T00:00:00.000Z` : undefined,
      dateToExclusive: dateTo ? new Date(nextDate(dateTo)).toISOString() : undefined,
      categoryProductIds: category ? getAllProducts().filter((product) => product.category === category).map(({ id }) => id) : undefined,
      ...distanceBands[distance],
    };
    const total = countOrders(filters);
    const pagination = getPagination(request.query, total, 8);
    const result = listOrders({ ...pagination, ...filters, sortDate });
    const categoryByProductId = new Map(getAllProducts().map(({ id, category }) => [id, category]));
    const orders = result.orders.map((order) => ({
      ...order,
      items: order.items.map((item) => ({ ...item, category: item.category || categoryByProductId.get(item.productId) })),
    }));
    const counts = Object.fromEntries(statuses.map((status) => [status, result.counts[status] || 0]));
    response.json({
      orders,
      pagination: { page: pagination.page, limit: pagination.limit, total: pagination.total, totalPages: pagination.totalPages },
      counts,
    });
  } catch (error) {
    console.error("SQLite order load failed:", error);
    response.status(500).json({ error: error.message });
  }
});

app.put("/api/orders/:id/status", requireOwner, async (request, response) => {
  const { status } = request.body || {};
  const cancellationReason = typeof request.body?.cancellationReason === "string" ? request.body.cancellationReason.trim() : "";
  if (!statuses.includes(status)) return response.status(400).json({ error: "Invalid order status." });
  if (status === "canceled" && !cancellationReason) return response.status(400).json({ error: "A cancellation reason is required." });
  if (cancellationReason.length > 1000) return response.status(400).json({ error: "Cancellation reasons must be 1000 characters or fewer." });

  let result;
  try {
    result = updateOrderStatus(request.params.id, status, cancellationReason);
  } catch (error) {
    console.error("SQLite order update failed:", error);
    return response.status(500).json({ error: error.message });
  }
  if (result.kind === "not-found") return response.status(404).json({ error: "Order not found." });
  if (result.kind === "delivered") return response.status(409).json({ error: "Delivered orders cannot be changed." });
  if (result.kind === "canceled") return response.status(409).json({ error: "Canceled orders cannot be changed." });
  if (result.kind === "same") return response.json({ order: result.order, notification: { sent: true, skipped: true } });

  const updatedOrder = result.order;
  try {
    if (!updatedOrder.email) throw new Error("This order has no customer email address.");
    await sendCustomerStatusEmail(updatedOrder);
    return response.json({ order: updatedOrder, notification: { sent: true } });
  } catch (notificationError) {
    console.error("Customer status email failed:", notificationError);
    return response.json({ order: updatedOrder, notification: { sent: false, warning: notificationError.message || "Customer email could not be sent." }, previousStatus: result.previousStatus });
  }
});

app.get("/api/docs/openapi.json", (_request, response) => response.json(createOpenApiDocument()));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(null, { swaggerOptions: { url: "/api/docs/openapi.json", withCredentials: true } }));

await initializeDatabase();
app.listen(port, () => console.log(`Milk Villa API listening on port ${port}`));
