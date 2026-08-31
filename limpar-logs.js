require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function limparLogsDeAcesso() {
  try {
    console.log('Iniciando a limpeza da tabela de AccessLog...');
    
    // Deleta todos os registros da tabela
    // Calcula a data de 30 dias atrás
    const trintaDiasAtras = new Date();
    trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 0);

    const resultado = await prisma.accessLog.deleteMany({
      where: {
        createdAt: {
          lt: trintaDiasAtras // "lt" significa "less than" (menor que / anterior a)
        }
      }
    });
    
    console.log(`✅ Sucesso! ${resultado.count} logs de acesso foram apagados do banco de dados.`);
  } catch (error) {
    console.error('❌ Erro ao apagar os logs:', error);
  } finally {
    // Encerra as conexões com o banco de dados
    await prisma.$disconnect();
    await pool.end();
  }
}

limparLogsDeAcesso();