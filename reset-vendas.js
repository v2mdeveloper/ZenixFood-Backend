require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

// Conecta ao banco de dados usando a URL do .env
const prisma = new PrismaClient();

async function resetSales() {
  try {
    console.log('🧹 Iniciando a limpeza geral de vendas e caixas...');

    // 0. Limpar Fiados (Contas Pendentes) e Desbloquear Clientes
    console.log('Apagando contas de Fiado e Desbloqueando Clientes...');
    await prisma.employeeAccountMovement.deleteMany({});
    await prisma.customerAccountMovement.deleteMany({});
    
    // Remove o bloqueio de clientes que tinham saído sem pagar
    await prisma.user.updateMany({
      where: { isBlocked: true },
      data: { isBlocked: false }
    });

    // 1. Limpar Itens das Comandas e as Comandas (Salão)
    console.log('Apagando Comandas e Mesas do Salão...');
    await prisma.tabItem.deleteMany({});
    await prisma.restaurantTab.deleteMany({});

    // 2. Limpar Itens dos Pedidos e os Pedidos (Delivery/Site/Totem)
    console.log('Apagando Histórico de Pedidos e Itens...');
    await prisma.orderItem.deleteMany({});
    await prisma.order.deleteMany({});

    // 3. Limpar Movimentações de Caixa, Gavetas e Turnos (PDV & Faturamento)
    console.log('Apagando Turnos, Caixas e Movimentações Financeiras...');
    await prisma.cashMovement.deleteMany({});
    await prisma.cashRegister.deleteMany({});
    await prisma.shift.deleteMany({});

    // 4. Limpar Analytics e Logs
    console.log('Limpando Logs de Funcionários e Acessos (Analytics)...');
    await prisma.employeeLog.deleteMany({});
    await prisma.accessLog.deleteMany({});

    // 5. Reiniciar o Contador (shortId) para voltar ao Pedido #1
    console.log('Reiniciando o contador de pedidos para 1...');
    await prisma.$executeRawUnsafe(`ALTER SEQUENCE "Order_shortId_seq" RESTART WITH 1;`);

    console.log('===================================================');
    console.log('✅ SUCESSO! Todas as vendas, turnos, fiados e caixas foram apagados.');
    console.log('🍔 Produtos, Clientes, Cashback, Avaliações e Funcionários foram MANTIDOS.');
    console.log('===================================================');

  } catch (error) {
    console.error('❌ ERRO ao tentar limpar o sistema:', error.message);
    console.log('Detalhes:', error);
  } finally {
    // Desconecta do banco de dados para encerrar o script
    await prisma.$disconnect();
  }
}

// Executa a função
resetSales();