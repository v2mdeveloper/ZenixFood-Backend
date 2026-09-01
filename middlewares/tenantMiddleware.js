const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function tenantMiddleware(req, res, next) {
  // 1. Identifica a loja que está fazendo a requisição
  const storeId = req.headers['x-store-id'];

  if (!storeId) {
    return res.status(400).json({ error: 'x-store-id não fornecido no cabeçalho.' });
  }

  try {
    // 2. Busca a loja no banco de dados
    const store = await prisma.store.findUnique({
      where: { id: storeId }
    });

    if (!store) {
      return res.status(404).json({ error: 'Loja (Tenant) não encontrada.' });
    }

    // 3. TRAVA DE SEGURANÇA: Bloqueia inadimplentes
    if (store.subscriptionStatus === 'BLOCKED' || store.subscriptionStatus === 'OVERDUE') {
      return res.status(402).json({ // 402 = Payment Required
        error: 'SUBSCRIPTION_REQUIRED',
        message: 'Acesso suspenso. Existem pendências financeiras na assinatura desta unidade.'
      });
    }

    // 4. Passa os dados da loja para as próximas rotas (Controllers)
    // Assim o seu backend sempre sabe as chaves do Mercado Pago ou da Focus a usar
    req.store = store;
    
    next();
  } catch (error) {
    console.error('Erro no Tenant Middleware:', error);
    return res.status(500).json({ error: 'Erro interno ao validar a unidade.' });
  }
}

module.exports = tenantMiddleware;