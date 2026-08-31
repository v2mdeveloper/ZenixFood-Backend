const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function reorganizarVendas() {
  try {
    console.log('⏳ Iniciando a reorganização dos números dos pedidos...');

    // 1. Busca todos os pedidos ordenados pela data exata em que foram criados
    const pedidos = await prisma.order.findMany({
      orderBy: {
        createdAt: 'asc', // Do mais antigo para o mais novo
      },
    });

    const totalPedidos = pedidos.length;
    console.log(`📦 Encontrados ${totalPedidos} pedidos no sistema para reorganizar.`);

    if (totalPedidos === 0) {
      console.log('Nenhum pedido encontrado. Finalizando script.');
      return;
    }

    // 2. Passo de Segurança: Mover os IDs para números negativos temporários.
    // Isso evita o erro de "Unique Constraint" (tentar dar o número 2 para um pedido enquanto outro ainda é o 2)
    console.log('🔄 Movendo numerações para área de segurança...');
    for (let i = 0; i < totalPedidos; i++) {
      await prisma.order.update({
        where: { id: pedidos[i].id },
        data: { shortId: -(i + 1) }, // Transforma em -1, -2, -3...
      });
    }

    // 3. Aplicar a numeração correta definitiva
    console.log(`✅ Aplicando a nova sequência de 1 a ${totalPedidos}...`);
    for (let i = 0; i < totalPedidos; i++) {
      await prisma.order.update({
        where: { id: pedidos[i].id },
        data: { shortId: i + 1 }, // Aplica 1, 2, 3...
      });
    }

    // 4. Ajustar o contador oficial do banco de dados para o próximo número
    const proximoNumero = totalPedidos + 1;
    console.log(`⏳ Ajustando o motor do banco para que a próxima venda seja a #${proximoNumero}...`);

    // ==============================================================================
    // SE VOCÊ USA POSTGRESQL (Padrão no Render/Supabase/Vercel):
    await prisma.$executeRawUnsafe(`ALTER SEQUENCE "Order_shortId_seq" RESTART WITH ${proximoNumero};`);
    
    // SE VOCÊ USA MYSQL:
    // await prisma.$executeRawUnsafe(`ALTER TABLE "Order" AUTO_INCREMENT = ${proximoNumero};`);
    // ==============================================================================

    console.log(`🎉 SUCESSO ABSOLUTO! Seus ${totalPedidos} pedidos foram reordenados perfeitamente.`);
    console.log(`🚀 O seu próximo pedido a entrar no sistema será o #${proximoNumero}.`);

  } catch (error) {
    console.error('❌ Ocorreu um erro durante a reorganização:', error);
  } finally {
    // Desconecta e fecha a porta com o banco de dados
    await prisma.$disconnect();
  }
}

// Executa a função
reorganizarVendas();