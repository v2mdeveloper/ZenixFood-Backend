const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_key";

const storeMiddleware = (req, res, next) => {
  // Webhooks de pagamento não precisam de storeId no cabeçalho
  if (req.path === "/api/webhook") return next();
  
  // 1. Tenta pegar pelo cabeçalho ou parâmetro da URL
  let storeId = req.headers["x-store-id"] || req.query.storeId;
  
  // 2. Se não veio, tenta extrair automaticamente do Token JWT (Bearer Token)
  if (!storeId && req.headers.authorization) {
    try {
      const token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && decoded.storeId) {
        storeId = decoded.storeId;
      }
    } catch (err) {
      // Token inválido ou expirado, prossegue sem storeId
    }
  }

  if (storeId) {
    req.storeId = storeId;
  }
  
  next();
};

module.exports = storeMiddleware;