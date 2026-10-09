export const getMongoConnectionUrl = () => {
  const uri = process.env.MONGODB_URI;
  const database = process.env.MONGODB_DB;
  if (!uri) throw new Error("MONGODB_URI must be configured.");
  if (!database) return uri;

  const authorityStart = uri.indexOf("://");
  if (authorityStart < 0) throw new Error("MONGODB_URI must be a valid MongoDB connection URI.");
  const queryStart = uri.indexOf("?", authorityStart + 3);
  const pathStart = uri.indexOf("/", authorityStart + 3);

  if (pathStart >= 0 && (queryStart < 0 || pathStart < queryStart)) {
    const pathEnd = queryStart < 0 ? uri.length : queryStart;
    if (uri.slice(pathStart, pathEnd) !== "/") return uri;
    return `${uri.slice(0, pathStart)}/${encodeURIComponent(database)}${uri.slice(pathEnd)}`;
  }

  const insertAt = queryStart < 0 ? uri.length : queryStart;
  return `${uri.slice(0, insertAt)}/${encodeURIComponent(database)}${uri.slice(insertAt)}`;
};
