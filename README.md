# Milk Villa backend

The API stores application data in MongoDB through Prisma. Set `MONGODB_URI` to a MongoDB connection URI; include the database name in the URI path, or set `MONGODB_DB` to provide it when the URI path is empty. On startup, the backend connects, creates the `products`, `orders`, and `email_verifications` collections and indexes when missing, and adds any missing default products without replacing existing products.

Use Node.js 22.13 or newer:

```sh
npm install
npm run dev
```

## One-time SQLite data migration

To preserve existing orders, products, and email verification records, run the importer **before starting the MongoDB-backed server for the first time**:

```sh
npm run migrate:sqlite -- --dry-run
npm run migrate:sqlite
```

The dry run reads and validates the source without connecting to MongoDB. The importer reads `milk-villa.sqlite` in read-only mode (or `SQLITE_DB_PATH` if explicitly set), performs idempotent upserts into the database selected by `MONGODB_URI`, and leaves the SQLite source file untouched. It does not run automatically. Once the counts have been checked in MongoDB, archive or remove the old SQLite file and its WAL/SHM companions yourself.

The admin dashboard no longer downloads SQLite backups. Use your MongoDB provider's backup or snapshot facility for database backups.
