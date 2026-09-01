require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🔄 Iniciando criação do Admin Master em todas as lojas...');

  // 1. Busca todas as lojas cadastradas no SaaS
  const stores = await prisma.store.findMany();

  if (stores.length === 0) {
    console.log('⚠️ Nenhuma loja cadastrada no banco de dados.');
    return;
  }

  const hashedPassword = await bcrypt.hash('masterzenix@#1206', 10);

  for (const store of stores) {
    console.log(`\n🏢 Processando loja: ${store.name} (Slug: ${store.slug})`);

    // 2. Verifica se já existe um perfil com permissão total ("Gestor Master" ou similar) nesta loja
    let profile = await prisma.accessProfile.findFirst({
      where: {
        storeId: store.id,
        name: 'Gestor Master'
      }
    });

    if (!profile) {
      profile = await prisma.accessProfile.create({
        data: {
          storeId: store.id,
          name: 'Gestor Master',
          permissions: JSON.stringify(['gestao', 'pdv', 'salao', 'kds', 'expedicao', 'historico', 'turnos', 'produtos', 'categorias', 'promocoes', 'estoque', 'analytics', 'crm', 'fornecedores', 'impressoes', 'fiscal', 'config'])
        }
      });
      console.log('  ✔️ Perfil "Gestor Master" criado para esta loja.');
    } else {
      console.log('  ℹ️ Perfil "Gestor Master" já existe nesta loja.');
    }

    // 3. Verifica se o funcionário masterzanix já existe nesta loja específica
    const existingEmployee = await prisma.employee.findFirst({
      where: {
        storeId: store.id,
        email: 'masterzanix@zenix.com.br'
      }
    });

    if (existingEmployee) {
      console.log('  ⏭️ Funcionário masterzanix@zenix.com.br já cadastrado nesta loja. Ignorando...');
    } else {
      await prisma.employee.create({
        data: {
          storeId: store.id,
          name: 'Master Zenix Admin',
          email: 'masterzanix@zenix.com.br',
          cpf: '11122233344', // CPF fictício único para atender a restrição da loja
          password: hashedPassword,
          role: 'Gestor Master',
          profileId: profile.id,
          isActive: true,
          receivesTips: false,
          creditLimit: 0.0,
          discountPercent: 0.0
        }
      });
      console.log('  ✅ Funcionário masterzanix@zenix.com.br criado com sucesso nesta loja!');
    }
  }

  console.log('\n✨ Processo finalizado com sucesso em todas as lojas!');
}

main()
  .catch((e) => {
    console.error('❌ Erro ao rodar o seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });