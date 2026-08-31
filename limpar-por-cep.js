require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function limparPorCep() {
  const cepAlvo = "CEP: 05780310"; // Substitua pelo CEP que você deseja apagar

  try {
    console.log(`Buscando pedidos com o endereço/CEP: ${cepAlvo}...`);

    // 1. Encontra todos os pedidos que contêm esse CEP no endereço
    const pedidosParaApagar = await prisma.order.findMany({
      where: {
        address: {
          contains: cepAlvo,
          mode: 'insensitive', // Ignora maiúsculas/minúsculas se houver
        },
      },
    });

    if (pedidosParaApagar.length === 0) {
      console.log('Nenhum pedido encontrado com este CEP.');
      return;
    }

    const idsDosPedidos = pedidosParaApagar.map(p => p.id);
    console.log(`Encontrados ${idsDosPedidos.length} pedido(s) para apagar.`);

    // 2. Apaga primeiro os itens vinculados a esses specific pedidos (para respeitar a restrição do banco)
    await prisma.orderItem.deleteMany({
      where: {
        orderId: { in: idsDosPedidos },
      },
    });

    // 3. Apaga os pedidos
    await prisma.order.deleteMany({
      where: {
        id: { in: idsDosPedidos },
      },
    });

    console.log(`✅ Sucesso! Os pedidos com o CEP ${cepAlvo} foram excluídos.`);
  } catch (error) {
    console.error('Erro ao excluir os pedidos por CEP:', error);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

limparPorCep();