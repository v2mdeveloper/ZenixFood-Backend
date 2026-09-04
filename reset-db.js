const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function resetDatabase() {
  console.log("🧹 Iniciando a limpeza geral do banco de dados...");
  
  try {
    // O comando TRUNCATE com CASCADE apaga todas as lojas e todas as 
    // tabelas filhas vinculadas a elas em cascata (produtos, usuários, etc.)
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Store" CASCADE;');
    
    console.log("✅ Limpeza concluída! Todas as lojas e dados vinculados foram apagados.");
    console.log("🚀 Seu painel Master está zerado e pronto para testes do zero.");
  } catch (error) {
    console.error("❌ Erro ao limpar o banco de dados:", error);
  } finally {
    await prisma.$disconnect();
  }
}

resetDatabase();