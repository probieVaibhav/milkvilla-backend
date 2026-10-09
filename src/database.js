import { Prisma, PrismaClient } from "@prisma/client";
import { getMongoConnectionUrl } from "./mongo-url.js";
import { products as defaultProducts } from "./products.js";

const collectionNames = ["products", "orders", "email_verifications"];
const prisma = new PrismaClient({ datasources: { db: { url: getMongoConnectionUrl() } } });
let initialization;

const ensureCollections = async () => {
  const result = await prisma.$runCommandRaw({ listCollections: 1, nameOnly: true });
  const existing = new Set(result.cursor.firstBatch.map(({ name }) => name));

  for (const collection of collectionNames) {
    if (!existing.has(collection)) {
      await prisma.$runCommandRaw({ create: collection });
    }
  }

  await prisma.$runCommandRaw({
    createIndexes: "products",
    indexes: [
      { key: { category: 1 }, name: "products_category_idx" },
      { key: { sortOrder: 1 }, name: "products_sortOrder_key", unique: true },
    ],
  });
  await prisma.$runCommandRaw({
    createIndexes: "orders",
    indexes: [
      { key: { createdAt: 1 }, name: "orders_createdAt_idx" },
      { key: { status: 1, createdAt: 1 }, name: "orders_status_createdAt_idx" },
      { key: { distanceKm: 1 }, name: "orders_distanceKm_idx" },
      { key: { productIds: 1 }, name: "orders_productIds_idx" },
    ],
  });
  await prisma.$runCommandRaw({
    createIndexes: "email_verifications",
    indexes: [{ key: { expiresAt: 1 }, name: "email_verifications_expiresAt_idx" }],
  });
};

const seedProducts = async () => {
  let sortOrder = (await prisma.product.aggregate({ _max: { sortOrder: true } }))._max.sortOrder || 0;

  for (const product of defaultProducts) {
    if (await prisma.product.findUnique({ where: { id: product.id }, select: { id: true } })) continue;
    sortOrder += 1;
    await prisma.product.create({ data: { ...product, sortOrder } });
  }
};

export const initializeDatabase = async () => {
  if (initialization) return initialization;

  initialization = (async () => {
    await prisma.$connect();
    try {
      await ensureCollections();
      await seedProducts();
      console.log("MongoDB database initialized.");
    } catch (error) {
      await prisma.$disconnect();
      throw error;
    }
  })();

  try {
    await initialization;
  } catch (error) {
    initialization = undefined;
    throw error;
  }
};

export const disconnectDatabase = () => prisma.$disconnect();

export const findVerifiedEmail = async (email) => Boolean((await prisma.emailVerification.findUnique({ where: { email }, select: { verifiedAt: true } }))?.verifiedAt);

export const readPendingVerification = async (email) => {
  const pending = await prisma.emailVerification.findUnique({ where: { email } });
  if (!pending?.nonce || pending.expiresAt === null || pending.lastSentAt === null) return null;
  return {
    email: pending.email,
    nonce: pending.nonce,
    expiresAt: pending.expiresAt,
    lastSentAt: pending.lastSentAt,
    checkout: pending.checkout,
  };
};

export const savePendingVerification = async (record) =>
  prisma.emailVerification.upsert({
    where: { email: record.email },
    create: record,
    update: {
      nonce: record.nonce,
      expiresAt: record.expiresAt,
      lastSentAt: record.lastSentAt,
      checkout: record.checkout,
    },
  });

const toProduct = ({ id, name, category, price, unit, description, emoji }) => ({ id, name, category, price, unit, description, emoji });

export const listProducts = async ({ offset = 0, limit = 50 } = {}) => {
  const [total, records] = await Promise.all([
    prisma.product.count(),
    prisma.product.findMany({ skip: offset, take: limit, orderBy: { sortOrder: "asc" } }),
  ]);
  return { products: records.map(toProduct), total };
};

export const listAdminProducts = async ({ cursor, limit = 20 }) => {
  const records = await prisma.product.findMany({
    where: cursor === null || cursor === undefined ? undefined : { sortOrder: { lt: cursor } },
    orderBy: { sortOrder: "desc" },
    take: limit + 1,
  });
  const hasMore = records.length > limit;
  const pageRecords = hasMore ? records.slice(0, limit) : records;
  return {
    products: pageRecords.map(toProduct),
    nextCursor: hasMore ? pageRecords[pageRecords.length - 1].sortOrder : null,
    hasMore,
    total: await prisma.product.count(),
  };
};

export const countProducts = () => prisma.product.count();

export const getAllProducts = async () => {
  const records = await prisma.product.findMany({ orderBy: { sortOrder: "asc" } });
  return records.map(toProduct);
};

export const listProductCategories = async () => {
  const products = await prisma.product.findMany({ distinct: ["category"], select: { category: true } });
  return products.map(({ category }) => category).sort((left, right) => left.localeCompare(right));
};

export const saveProduct = async ({ packSize, unitType, ...product }) => {
  const normalizedPackSize = String(packSize);
  const unitSlug = unitType.toLowerCase();
  const baseId = `${product.category}-${normalizedPackSize.replace(".", "-")}${unitSlug}`;
  const nameSlug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product";
  let id = baseId;
  let suffix = 1;
  while (await prisma.product.findUnique({ where: { id }, select: { id: true } })) {
    id = `${baseId}-${nameSlug}${suffix === 1 ? "" : `-${suffix}`}`;
    suffix += 1;
  }

  const lastProduct = await prisma.product.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const savedProduct = { ...product, id, unit: `${normalizedPackSize} ${unitType}` };
  await prisma.product.create({ data: { ...savedProduct, sortOrder: (lastProduct?.sortOrder || 0) + 1 } });
  return savedProduct;
};

export const completeEmailVerification = async (email, nonce) => {
  const now = Date.now();
  const pending = await prisma.emailVerification.findFirst({
    where: { email, nonce, expiresAt: { gt: now }, verifiedAt: null },
  });
  if (!pending) return null;

  const claimed = await prisma.emailVerification.updateMany({
    where: { email, nonce, expiresAt: { gt: now }, verifiedAt: null },
    data: {
      verifiedAt: new Date(),
      nonce: null,
      expiresAt: null,
      lastSentAt: null,
      checkout: Prisma.JsonNull,
    },
  });
  if (claimed.count === 0) return null;

  return pending.checkout;
};

export const saveOrder = async (order) =>
  prisma.order.create({
    data: {
      ...order,
      createdAt: new Date(order.createdAt),
      productIds: order.items.map(({ productId }) => productId),
    },
  });

const buildOrderFilter = ({ status, dateFrom, dateToExclusive, categoryProductIds, minDistanceKm, minDistanceInclusive, maxDistanceKm } = {}) => {
  const where = {};
  if (status) where.status = status;
  if (dateFrom || dateToExclusive) {
    where.createdAt = {
      ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
      ...(dateToExclusive ? { lt: new Date(dateToExclusive) } : {}),
    };
  }
  if (categoryProductIds?.length) where.productIds = { hasSome: categoryProductIds };
  if (minDistanceKm !== undefined || maxDistanceKm !== undefined) {
    where.distanceKm = {
      ...(minDistanceKm !== undefined ? { [minDistanceInclusive ? "gte" : "gt"]: minDistanceKm } : {}),
      ...(maxDistanceKm !== undefined ? { lte: maxDistanceKm } : {}),
    };
  }
  return where;
};

export const countOrders = (filters = {}) => prisma.order.count({ where: buildOrderFilter(filters) });

export const listOrders = async ({ offset, limit, sortDate = "newest", ...filters }) => {
  const where = buildOrderFilter(filters);
  const [orders, groupedCounts] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ createdAt: sortDate === "oldest" ? "asc" : "desc" }, { id: "asc" }],
      skip: offset,
      take: limit,
    }),
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(groupedCounts.map(({ status, _count }) => [status, _count._all]));
  return { orders, counts };
};

const getStatusResult = (order, status) => {
  if (!order) return { kind: "not-found" };
  if (order.status === "delivered") return { kind: "delivered" };
  if (order.status === "canceled") return { kind: "canceled" };
  if (order.status === status) return { kind: "same", order };
  return null;
};

export const updateOrderStatus = async (id, status, cancellationReason) => {
  let order = await prisma.order.findUnique({ where: { id } });

  while (order) {
    const stateResult = getStatusResult(order, status);
    if (stateResult) return stateResult;

    const previousStatus = order.status;
    const data = { status, ...(status === "canceled" ? { cancellationReason } : {}) };
    const update = await prisma.order.updateMany({ where: { id, status: previousStatus }, data });
    if (update.count) return { kind: "updated", order: { ...order, ...data }, previousStatus };
    order = await prisma.order.findUnique({ where: { id } });
  }

  return { kind: "not-found" };
};
