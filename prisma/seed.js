require('dotenv').config(); // Carrega as variáveis do arquivo .env
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

// 1. Cria a conexão com o PostgreSQL usando a URL do .env
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });

// 2. Conecta o Prisma usando o Adapter do Postgres
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Limpa dados antigos para evitar duplicidade caso você rode o seed mais de uma vez
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.cashbackWallet.deleteMany({});
  await prisma.user.deleteMany({});

  console.log('Criando usuários...');
  
  // 3. Criar Usuários Administrativos, Clientes e Entregadores
  const admin = await prisma.user.create({
    data: {
      name: 'Gerente da Hamburgueria',
      email: 'admin@hamburgueria.com',
      password: 'senha_criptografada_aqui', // Em produção, use bcrypt
      role: 'ADMIN',
      phone: '11999999999'
    }
  });

  const client = await prisma.user.create({
    data: {
      name: 'João Silva',
      email: 'joao@email.com',
      password: 'senha_criptografada_aqui',
      role: 'CLIENT',
      phone: '11988888888',
      cashback: {
        create: { balance: 10.00 } // Começa com R$ 10 de saldo na carteira
      }
    }
  });

  const deliveryman = await prisma.user.create({
    data: {
      name: 'Carlos Motoboy',
      email: 'carlos@entrega.com',
      password: 'senha_criptografada_aqui',
      role: 'DELIVERY',
      phone: '11977777777'
    }
  });

  console.log('Criando categorias...');

  // 4. Criar Categorias do Cardápio
  const catBurgers = await prisma.category.create({
    data: { name: 'Hambúrgueres', slug: 'hamburgueres' }
  });

  const catBebidas = await prisma.category.create({
    data: { name: 'Bebidas', slug: 'bebidas' }
  });

  console.log('Criando produtos...');

  // 5. Criar Produtos do Cardápio
  await prisma.product.createMany({
    data: [
      {
        name: 'Double Burger Caramelizado',
        description: 'Pão brioche, 2 hambúrgueres de 110g, queijo prato, cebola caramelizada, picles e molho especial da casa.',
        price: 34.90,
        categoryId: catBurgers.id
      },
      {
        name: 'Jalapeño Burger 220g',
        description: 'Pão brioche, hambúrguer de 220g, queijo prato, cebola caramelizada, picles, pimenta jalapeño e molho especial da casa.',
        price: 39.90,
        categoryId: catBurgers.id
      },
      {
        name: 'Hambúrguer Vegano de Aveia',
        description: 'Pão brioche vegano, hambúrguer de aveia e cenoura de 120g, queijo vegano, tomate, alface, picles e maionese vegana da casa.',
        price: 32.00,
        categoryId: catBurgers.id
      },
      {
        name: 'Refrigerante Lata',
        description: 'Coca-Cola ou Guaraná Antarctica 350ml',
        price: 6.00,
        categoryId: catBebidas.id
      }
    ]
  });

  console.log('Banco de dados populado com sucesso!');
}

main()
  .catch((e) => {
    console.error('Erro ao popular o banco de dados:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });