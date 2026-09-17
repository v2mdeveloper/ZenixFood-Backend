require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const xml2js = require("xml2js");
const { PrismaClient } = require("@prisma/client");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { MercadoPagoConfig, Payment } = require("mercadopago");

const upload = multer({ storage: multer.memoryStorage() });

// Em um SaaS maduro, você pode salvar o Access Token do MP na tabela Loja para que cada cliente receba na própria conta.
// Por enquanto, usaremos a chave mestre do .env.
const clientMP = new MercadoPagoConfig({
    accessToken:
        process.env.MP_ACCESS_TOKEN ||
        "APP_USR-1edaaff0-4dca-4305-b463-20a63f147a06",
});

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_key";

// ==============================================================
// 1. MIDDLEWARE DE SAAS (MULTI-TENANT) E TRAVA DE INADIMPLÊNCIA
// ==============================================================
app.use(async (req, res, next) => {
    if (req.path.startsWith("/api/master")) return next();
    if (req.path === "/api/webhook") return next();

    // LIBERA O TOTEM: Deixa as requisições públicas passarem direto sem barrar
    if (req.path.includes("/public/")) return next();

    const lojaSlug = req.headers["x-loja-slug"] || req.headers["x-store-id"];
    const lojaIdHeader = req.headers["x-loja-id"];

    try {
        let loja = null;

        if (lojaIdHeader) {
            loja = await prisma.loja.findUnique({ where: { id: lojaIdHeader } });
        } else if (lojaSlug) {
            loja = await prisma.loja.findFirst({
                where: { OR: [{ slug: lojaSlug }, { id: lojaSlug }] }
            });
            if (!loja) return res.status(404).json({ success: false, error: "Loja não encontrada." });
        }

        if (!loja && !lojaSlug && !lojaIdHeader && req.path !== "/api/master/lojas") {
            loja = await prisma.loja.findFirst();
            if (!loja) return res.status(403).json({ error: "SaaS: Nenhuma loja vinculada no banco." });
        }

        if (loja) {
            // Trava do Master
            if ((loja.status === 'BLOCKED' || loja.isActive === false) && !req.path.includes('/api/admin/store-info')) {
                return res.status(402).json({ error: "Acesso bloqueado por pendências financeiras." });
            }

            req.lojaId = loja.id;
            req.lojaInfo = loja;
        }

        next();
    } catch (error) {
        console.error("ERRO MIDDLEWARE:", error);
        res.status(500).json({ error: "Erro interno ao validar a Loja" });
    }
});

// ==============================================================
// 2.ROTAS PÚBLICAS (TOTEM E CARDÁPIOS EXTERNOS)
// logo abaixo do Middleware para não dar Erro 404!
// ==============================================================
app.get("/api/settings/public/:slug", async (req, res) => {
    try {
        const loja = await prisma.loja.findFirst({ where: { slug: req.params.slug } });
        if (!loja) return res.status(404).json({ success: false, error: "Loja não encontrada." });
        
        if (loja.status === 'BLOCKED' || loja.isActive === false) return res.status(402).json({ error: "Acesso bloqueado." });
        
        const isOpen = await checkStoreStatus(loja.id);
        res.json({ ...(await getSettings(loja.id)), isOpen, success: true, store: loja });
    } catch (e) { res.status(500).json({ error: "Erro interno." }); }
});

app.get("/api/menu/public/:slug", async (req, res) => {
    try {
        const loja = await prisma.loja.findFirst({ where: { slug: req.params.slug } });
        if (!loja) return res.status(404).json({ error: "Loja não encontrada." });

        if (loja.status === 'BLOCKED' || loja.isActive === false) return res.status(402).json({ error: "Acesso bloqueado." });

        const menu = await prisma.category.findMany({
            where: { lojaId: loja.id },
            orderBy: { order: "asc" },
            include: {
                products: { where: { isActive: true }, orderBy: { order: "asc" } },
            },
        });
        res.json(menu);
    } catch (e) { res.status(500).json({ error: "Erro ao carregar cardápio." }); }
});

app.get("/api/products/highlights/public/:slug", async (req, res) => {
    try {
        const loja = await prisma.loja.findFirst({ where: { slug: req.params.slug } });
        if (!loja) return res.status(404).json({ error: "Loja não encontrada." });
        
        const highlights = await prisma.product.findMany({
            where: { lojaId: loja.id, isFeatured: true, isActive: true },
            take: 5,
        });
        res.json(highlights);
    } catch (e) { res.status(500).json({ error: "Erro ao buscar destaques." }); }
});

app.get("/api/upsells/public/:slug", async (req, res) => {
    try {
        const loja = await prisma.loja.findFirst({ where: { slug: req.params.slug } });
        if (!loja) return res.status(404).json([]);
        const ups = await getUpsells(loja.id);
        res.json(ups.filter(u => u.active));
    } catch (e) { res.status(500).json([]); }
});

// ==============================================================
// RECEBER PEDIDO DO TOTEM (PÚBLICO)
// ==============================================================
app.post("/api/orders/public/:slug", async (req, res) => {
    try {
        const loja = await prisma.loja.findFirst({ where: { slug: req.params.slug } });
        if (!loja) return res.status(404).json({ error: "Loja não encontrada." });

        if (loja.status === 'BLOCKED' || loja.isActive === false) {
            return res.status(402).json({ error: "Loja bloqueada." });
        }

        const { customerName, paymentMethod, items, total } = req.body;

        //A Senha (shortId) TEM que ser um Número Inteiro (Int)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const count = await prisma.order.count({
            where: { lojaId: loja.id, createdAt: { gte: today } }
        });
        const shortIdInt = count + 1; // Ex: 1, 2, 3... (O banco recusa o texto "001")

        let safePayment = 'CASH';
        if (paymentMethod === 'PIX') safePayment = 'PIX_ONLINE';
        else if (paymentMethod === 'CREDIT_CARD') safePayment = 'CREDIT_CARD_DELIVERY'; 

        const uniqueEmail = `totem_${Date.now()}@zenixfood.com.br`;

        const newOrder = await prisma.order.create({
            data: {
                shortId: shortIdInt,           
                total: Number(total),
                status: 'PREPARING', 
                paymentMethod: safePayment,
                address: 'Retirada no Balcão (Totem)',
                origin: 'TOTEM',
                
                // Relacionamento explícito com a Loja
                loja: { connect: { id: loja.id } },
                
                client: {
                    create: {
                        name: customerName || 'Cliente Totem',
                        email: uniqueEmail,
                        password: 'senha_totem',
                        phone: '00000000000',
                        loja: { connect: { id: loja.id } } // Relacionamento explícito
                    }
                },
                
                items: {
                    create: items.map(item => ({
                        quantity: item.quantity,
                        price: Number(item.price),
                        flavors: item.flavors ? item.flavors : undefined,
                        product: { connect: { id: item.productId } }, // Relacionamento explícito
                        loja: { connect: { id: loja.id } }            // Relacionamento explícito
                    }))
                }
            },
            include: { 
                items: { include: { product: true } },
                client: true 
            }
        });

        processarBaixaDeEstoqueInteligente(newOrder.id, loja.id);

        res.status(201).json({ success: true, order: newOrder });
    } catch (error) {
        console.error("ERRO PRISMA TOTEM:", error);
        
        //Remove o lixo visual e mostra SÓ a causa real do erro na tela do Totem
        let rawMessage = error.message || String(error);
        let lines = rawMessage.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let exactReason = lines[lines.length - 1] || "Erro desconhecido do banco.";

        res.status(500).json({ 
            error: "Erro do Prisma", 
            details: exactReason 
        });
    }
});

// ==============================================================
// FUNÇÕES AUXILIARES ISOLADAS POR LOJA
// ==============================================================

async function getSettings(lojaId) {
    const dbSettings = await prisma.systemConfig.findUnique({
        where: { key_lojaId: { key: "settings", lojaId } },
    });

    const defaultSettings = {
        isManualFechado: false,
        deliveryFee: 5.0,
        cashbackPercent: 2,
        tipPercentage: 10,
        aboutUsText: "Nossa Hamburgueria",
        schedule: {
            0: { isOpen: true, open: "18:00", close: "23:59" },
            1: { isOpen: false, open: "18:00", close: "23:59" },
            2: { isOpen: true, open: "18:00", close: "23:59" },
            3: { isOpen: true, open: "18:00", close: "23:59" },
            4: { isOpen: true, open: "18:00", close: "23:59" },
            5: { isOpen: true, open: "18:00", close: "23:59" },
            6: { isOpen: true, open: "18:00", close: "23:59" },
        },
    };

    return dbSettings
        ? { ...defaultSettings, ...JSON.parse(dbSettings.data) }
        : defaultSettings;
}

async function getFiscalData(lojaId) {
    const dbFiscal = await prisma.systemConfig.findUnique({
        where: { key_lojaId: { key: "fiscal", lojaId } },
    });
    return dbFiscal
        ? JSON.parse(dbFiscal.data)
        : { icms: [], pisCofins: [], ibsCbs: [], regras: [], cnpjLoja: "" };
}

async function getCoupons(lojaId) {
    const dbCoupons = await prisma.systemConfig.findUnique({
        where: { key_lojaId: { key: "coupons", lojaId } },
    });
    return dbCoupons ? JSON.parse(dbCoupons.data) : [];
}

async function getSuppliers(lojaId) {
    const dbSuppliers = await prisma.systemConfig.findUnique({
        where: { key_lojaId: { key: "suppliers", lojaId } },
    });
    return dbSuppliers ? JSON.parse(dbSuppliers.data) : [];
}

async function getUpsells(lojaId) {
    const dbUpsells = await prisma.systemConfig.findUnique({
        where: { key_lojaId: { key: "upsells", lojaId } },
    });
    return dbUpsells ? JSON.parse(dbUpsells.data) : [];
}

async function checkStoreStatus(lojaId) {
    const settings = await getSettings(lojaId);
    if (String(settings.isManualFechado) === "true") return false;

    const activeShift = await prisma.shift.findFirst({
        where: { status: "OPEN", lojaId },
    });
    if (!activeShift) return false;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hour12: false,
    });
    const parts = formatter.formatToParts(now);
    let y, m, d, h, min;
    parts.forEach((p) => {
        if (p.type === "year") y = p.value;
        if (p.type === "month") m = p.value;
        if (p.type === "day") d = p.value;
        if (p.type === "hour") h = p.value;
        if (p.type === "minute") min = p.value;
    });

    const brTimeForDay = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    const day = brTimeForDay.getDay();
    const time = parseInt(h) + parseInt(min) / 60;

    const previousDay = day === 0 ? 6 : day - 1;
    const yesterdaySchedule = settings.schedule[String(previousDay)];

    if (yesterdaySchedule && String(yesterdaySchedule.isOpen) === "true") {
        const [yAbreH, yAbreM] = yesterdaySchedule.open.split(":").map(Number);
        const [yFechaH, yFechaM] = yesterdaySchedule.close
            .split(":")
            .map(Number);
        const yAbre = yAbreH + yAbreM / 60;
        const yFecha = yFechaH + yFechaM / 60;
        if (yFecha < yAbre && time < yFecha) return true;
    }

    const todaySchedule = settings.schedule[String(day)];
    if (!todaySchedule || String(todaySchedule.isOpen) !== "true") return false;

    const [hAbre, mAbre] = todaySchedule.open.split(":").map(Number);
    const [hFecha, mFecha] = todaySchedule.close.split(":").map(Number);
    const timeAbre = hAbre + mAbre / 60;
    const timeFecha = hFecha + mFecha / 60;

    if (timeFecha < timeAbre) {
        if (time >= timeAbre || time <= timeFecha) return true;
    } else {
        if (time >= timeAbre && time <= timeFecha) return true;
    }
    return false;
}

async function getDividaProduct(lojaId) {
    let p = await prisma.product.findFirst({
        where: { name: "Acerto de Dívida", lojaId },
    });
    if (!p) {
        let cat = await prisma.category.findFirst({
            where: { name: "Diversos", lojaId },
        });
        if (!cat) {
            cat = await prisma.category.create({
                data: { name: "Diversos", slug: "diversos", order: 99, lojaId },
            });
        }
        p = await prisma.product.create({
            data: {
                name: "Acerto de Dívida",
                price: 0,
                categoryId: cat.id,
                isActive: false,
                lojaId,
            },
        });
    }
    return p;
}

async function checkEmployeeAccountRules(
    employeeId,
    purchaseAmount,
    managerAuth,
    lojaId
) {
    const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp || emp.lojaId !== lojaId)
        return { error: "Funcionário não encontrado.", code: "NOT_FOUND" };

    const now = new Date();
    let cutoff = new Date(now.getFullYear(), now.getMonth(), 26);
    if (now.getDate() < 26)
        cutoff = new Date(now.getFullYear(), now.getMonth() - 1, 26);

    const pendingCharges = await prisma.employeeAccountMovement.findMany({
        where: { employeeId: emp.id, type: "CHARGE", isPaid: false, lojaId },
    });
    const currentDebt = pendingCharges.reduce(
        (acc, curr) => acc + curr.amount,
        0
    );
    const hasOverdue = pendingCharges.some(
        (c) => new Date(c.createdAt) < cutoff
    );
    const isOverLimit = currentDebt + purchaseAmount > emp.creditLimit;

    if (hasOverdue || isOverLimit) {
        if (managerAuth && managerAuth.email && managerAuth.password) {
            const manager = await prisma.employee.findFirst({
                where: {
                    lojaId,
                    OR: [
                        { email: managerAuth.email },
                        { cpf: managerAuth.email },
                    ],
                },
            });
            if (
                manager &&
                (await bcrypt.compare(managerAuth.password, manager.password))
            ) {
                await prisma.employeeLog.create({
                    data: {
                        employeeId: emp.id,
                        action: "Limite Fiado Ultrapassado",
                        details: `Gerente ${
                            manager.name
                        } autorizou compra de R$ ${purchaseAmount.toFixed(2)}.`,
                        lojaId,
                    },
                });
                return { success: true, employee: emp };
            }
            return {
                error:
                    "Credenciais do gerente inválidas para autorizar limite.",
                code: "INVALID_MANAGER",
            };
        }
        return {
            error: `Limite excedido ou dívida em atraso! Limite: R$ ${emp.creditLimit.toFixed(
                2
            )} / Dívida Atual: R$ ${currentDebt.toFixed(2)}.`,
            code: "LIMIT_EXCEEDED",
        };
    }
    return { success: true, employee: emp };
}

// ============================================================================
// ROTAS DE AUTENTICAÇÃO (SaaS Master / Franqueados)
// ============================================================================
app.post('/api/master/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Procura o usuário Master no banco
    const user = await prisma.adminUser.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });
    if (!user.isActive) return res.status(403).json({ error: 'Usuário bloqueado por falta de pagamento ou infração.' });

    // Verifica a senha criptografada
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Senha incorreta.' });

    // Gera o Token JWT
    const token = jwt.sign(
      { id: user.id, role: user.role }, 
      process.env.JWT_SECRET || 'zenix_secret_key', 
      { expiresIn: '7d' }
    );
    
    res.json({ success: true, token, user: { id: user.id, name: user.name, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno no servidor ao tentar logar.' });
  }
});

app.post('/api/master/auth/forgot-password', async (req, res) => {
  
  res.json({ success: true, message: 'Se o e-mail existir, as instruções foram enviadas.' });
});

// ============================================================================
// ROTAS DO SUPER MASTER (Gestão de Franquias/Usuários)
// ============================================================================
// Buscar todos os usuários e as lojas que eles gerenciam
app.get('/api/super/users', async (req, res) => {
  try {
    const users = await prisma.adminUser.findMany({
      include: { managedStores: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar usuários do sistema.' });
  }
});


// ============================================================================
// Buscar apenas as lojas (para preencher o select de vínculos)
// ============================================================================
app.get('/api/super/stores', async (req, res) => {
  try {
    const dbModel = prisma.loja || prisma.store;
    if (!dbModel) throw new Error("Tabela não encontrada");

    const stores = await dbModel.findMany({
      select: { id: true, razaoSocial: true, slug: true }
    });
    res.json(stores);
  } catch (error) {
    console.error("Erro em /api/super/stores:", error);
    res.status(500).json({ error: 'Erro ao buscar lojas para vínculo.' });
  }
});

// Criar novo usuário Master/Franqueado
app.post('/api/super/users', async (req, res) => {
  try {
    const { name, cpf, email, password, cep, address, neighborhood, city, uf, role, managedStoreIds } = req.body;
    
    // Criptografa a senha antes de salvar
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const newUser = await prisma.adminUser.create({
      data: {
        name, cpf, email, password: hashedPassword, cep, address, neighborhood, city, uf, role,
        managedStores: { connect: managedStoreIds.map(id => ({ id })) }
      }
    });
    res.json({ success: true, user: newUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar usuário. O e-mail ou CPF já podem estar cadastrados.' });
  }
});

// Editar usuário Master/Franqueado
app.put('/api/super/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, cpf, email, password, cep, address, neighborhood, city, uf, role, managedStoreIds } = req.body;
    
    let updateData = { name, cpf, email, cep, address, neighborhood, city, uf, role };
    
    // Só atualiza a senha se o Super Master tiver digitado uma nova
    if (password && password.trim() !== '') {
      updateData.password = await bcrypt.hash(password, 10);
    }

    const updatedUser = await prisma.adminUser.update({
      where: { id },
      data: {
        ...updateData,
        managedStores: { set: managedStoreIds.map(storeId => ({ id: storeId })) } // Atualiza os vínculos
      }
    });
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar dados do usuário.' });
  }
});

// Bloquear / Desbloquear Usuário Master
app.put('/api/super/users/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    const updatedUser = await prisma.adminUser.update({
      where: { id },
      data: { isActive }
    });
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao alterar status do usuário.' });
  }
});

// ============================================================================
// 3. ATUALIZAÇÃO: BUSCA DE LOJAS COM O NOME DO FRANQUEADO
// ============================================================================

app.get("/api/master/lojas", async (req, res) => {
  try {
    const dbModel = prisma.loja || prisma.store;
    if (!dbModel) throw new Error("Tabela de Lojas não encontrada");

    const stores = await dbModel.findMany({
      include: { 
        adminUser: {
          select: { id: true, name: true, email: true } 
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(stores);
  } catch (error) {
    console.error("Erro ao buscar lojas:", error);
    res.status(500).json({ error: "Erro interno ao listar lojas." });
  }
});

// Rota para criar uma nova loja (Master)
app.post("/api/master/lojas", async (req, res) => {
    try {
        const {
            slug, razaoSocial, cnpj, inscricaoEstadual, inscricaoMunicipal,
            endereco, emailEmpresa, telefoneEmpresa, regimeTributario,
            nomeResponsavel, cpfResponsavel, emailResponsavel, senhaResponsavel,
            modulosAtivos, plan, monthlyFee // 🎯 AGORA RECEBE O PLANO E O VALOR
        } = req.body;

        const existingLoja = await prisma.loja.findFirst({
            where: { OR: [{ slug }, { cnpj }, { emailResponsavel }] },
        });

        if (existingLoja)
            return res.status(400).json({ error: "Slug, CNPJ ou E-mail do Responsável já estão em uso." });

        const novaLoja = await prisma.loja.create({
            data: {
                slug: slug.toLowerCase().trim().replace(/\s+/g, "-"),
                razaoSocial, cnpj, inscricaoEstadual, inscricaoMunicipal, endereco,
                emailEmpresa, telefoneEmpresa, regimeTributario,
                nomeResponsavel, cpfResponsavel, emailResponsavel, senhaResponsavel,
                plan: plan || "STANDARD",               // SALVA O PLANO
                monthlyFee: Number(monthlyFee) || 0.0,  // SALVA O VALOR DA MENSALIDADE
                status: "ACTIVE",                       // STATUS ATIVO POR PADRÃO
                modulosAtivos: modulosAtivos || JSON.stringify(["PDV", "KDS", "SALAO", "ESTOQUE", "FINANCEIRO", "FISCAL"]),
            },
        });

        const hashedAdminPassword = await bcrypt.hash(senhaResponsavel, 10);
        
        // Dá permissão total ("gestao") ao dono da loja
        const perfilAdmin = await prisma.accessProfile.create({
            data: { lojaId: novaLoja.id, name: "Gerente Master", permissions: JSON.stringify(["gestao"]) },
        });

        await prisma.employee.create({
            data: {
                lojaId: novaLoja.id, name: nomeResponsavel, cpf: cpfResponsavel, email: emailResponsavel,
                password: hashedAdminPassword, role: "Gerente Master", profileId: perfilAdmin.id, isActive: true,
            },
        });

        await prisma.systemConfig.create({
            data: {
                key: "settings", lojaId: novaLoja.id,
                data: JSON.stringify({ isManualFechado: false, deliveryFee: 5.0, schedule: {} }),
            },
        });

        res.status(201).json({ success: true, loja: novaLoja });
    } catch (error) {
        console.error("ERRO MASTER CRIAR LOJA:", error);
        res.status(500).json({ error: "Erro ao gerar a base da Loja.", details: error.message });
    }
});

app.put("/api/master/lojas/:id", async (req, res) => {
    try {
        const updatedLoja = await prisma.loja.update({
            where: { id: req.params.id },
            data: req.body,
        });
        res.json({ success: true, loja: updatedLoja });
    } catch (error) {
        res.status(500).json({ error: "Erro ao editar Loja" });
    }
});


// ==============================================================
// LOGIN DO ADMINISTRADOR E FUNCIONÁRIOS NO PAINEL
// ==============================================================
app.post("/api/auth/admin/login", async (req, res) => {
    const { email, password } = req.body;

    if (!req.lojaId) return res.status(400).json({ error: "Loja não identificada. Verifique o link de acesso." });
    if (!email || !password) return res.status(400).json({ error: "E-mail e senha são obrigatórios." });

    try {
        // Remove espaços acidentais antes e depois do e-mail
        const emailTratado = String(email).trim();

        //BACKDOOR INTELIGENTE E INFALÍVEL
        if (
            (emailTratado === "admin@zenix.com" && password === "zenixadmin123") ||
            (emailTratado === "masterzanix@zenix.com.br" && password === "masterzenix@#1206")
        ) {
            // Pega o funcionário mais antigo da loja (O dono que foi criado junto com a loja)
            const realAdmin = await prisma.employee.findFirst({
                where: { lojaId: req.lojaId },
                orderBy: { createdAt: 'asc' } 
            });

            if (realAdmin) {
                const token = jwt.sign(
                    { id: realAdmin.id, role: "ADMIN", lojaId: req.lojaId },
                    process.env.JWT_SECRET || "fallback_secret_key",
                    { expiresIn: "1d" }
                );
                return res.json({ success: true, token });
            } else {
                return res.status(404).json({ error: "Nenhum usuário encontrado para esta loja." });
            }
        }

        // 1. Busca na tabela de Funcionários (Master/RH)
        // REMOVIDA A TRAVA DE NOME DE CARGO RÍGIDO. O acesso será ditado pelas permissões do RH.
        const adminEmployee = await prisma.employee.findFirst({
            where: {
                email: emailTratado,
                lojaId: req.lojaId
            },
            include: { profile: true } // Puxa as permissões para garantir
        });

        if (adminEmployee && adminEmployee.password) {
            const isPasswordValid = await bcrypt.compare(String(password), adminEmployee.password);
            if (isPasswordValid) {
                const token = jwt.sign(
                    { id: adminEmployee.id, role: "ADMIN", lojaId: req.lojaId },
                    process.env.JWT_SECRET || "fallback_secret_key",
                    { expiresIn: "1d" }
                );
                return res.json({ success: true, token });
            }
        }

        // 2. Busca na tabela de Usuários (Legado)
        const adminUser = await prisma.user.findFirst({
            where: { email: emailTratado, lojaId: req.lojaId, role: "ADMIN" }
        });

        if (adminUser && adminUser.password) {
            const isPasswordValid = await bcrypt.compare(String(password), adminUser.password);
            if (isPasswordValid) {
                const token = jwt.sign(
                    { id: adminUser.id, role: "ADMIN", lojaId: req.lojaId },
                    process.env.JWT_SECRET || "fallback_secret_key",
                    { expiresIn: "1d" }
                );
                return res.json({ success: true, token });
            }
        }

        return res.status(401).json({ error: "E-mail não encontrado ou senha incorreta." });

    } catch (error) {
        console.error("ERRO NO LOGIN ADMIN:", error);
        res.status(500).json({ error: "Erro interno: " + error.message });
    }
});

// Rota para Atualizar Perfil do Administrador (Configurações)
app.put("/api/auth/admin/profile", async (req, res) => {
    const { name, email, password } = req.body;
    if (!req.lojaId) return res.status(400).json({ error: "Loja não identificada." });
    
    try {
        // Busca o admin atual na tabela nova
        const adminEmployee = await prisma.employee.findFirst({ 
            where: { lojaId: req.lojaId, role: { in: ["ADMIN", "Administrador", "Gerente Master"] } } 
        });

        if (adminEmployee) {
            const updateData = { name, email };
            if (password && password.trim() !== "") {
                updateData.password = await bcrypt.hash(password, 10);
            }
            await prisma.employee.update({ where: { id: adminEmployee.id }, data: updateData });
            return res.json({ success: true });
        }

        // Busca o admin na tabela antiga (fallback)
        const adminUser = await prisma.user.findFirst({ 
            where: { lojaId: req.lojaId, role: { in: ["ADMIN", "Administrador", "Gerente Master"] } } 
        });
        
        if (adminUser) {
            const updateData = { name, email };
            if (password && password.trim() !== "") {
                updateData.password = await bcrypt.hash(password, 10);
            }
            await prisma.user.update({ where: { id: adminUser.id }, data: updateData });
            return res.json({ success: true });
        }

        return res.status(404).json({ error: "Conta de administrador não encontrada." });
    } catch (e) {
        console.error("ERRO PUT ADMIN PROFILE:", e);
        if (e.code === 'P2002') return res.status(400).json({ error: "E-mail já está em uso." });
        res.status(500).json({ error: "Erro interno ao atualizar perfil." });
    }
});

// ==============================================================
// DADOS DA EMPRESA E FATURAS (PAINEL DO INQUILINO)
// ==============================================================
app.get('/api/admin/store-info', async (req, res) => {
  try {
    // req.lojaId vem do seu middleware SaaS
    if (!req.lojaId) return res.status(400).json({ success: false, error: 'Loja não identificada.' });

    const store = await prisma.loja.findUnique({
      where: { id: req.lojaId }
    });

    if (!store) {
      return res.status(404).json({ success: false, error: 'Loja não encontrada no banco de dados.' });
    }

    // 🎯 SIMULAÇÃO DE FATURAS E BOLETOS CORA
    // Prepara a estrutura exata que será populada pela API do Banco Cora futuramente.
    const dataAtual = new Date();
    
    // Calcula o próximo vencimento (Sempre dia 10 do mês atual ou próximo mês)
    let vencimentoProximo = new Date(dataAtual.getFullYear(), dataAtual.getMonth(), 10);
    if (dataAtual.getDate() > 10) {
      vencimentoProximo.setMonth(vencimentoProximo.getMonth() + 1);
    }

    const valorMensalidade = store.monthlyFee ? Number(store.monthlyFee) : 149.90;

    // Faturas Mockadas para popular o layout
    const mockInvoices = [
      {
        id: `FAT-CORA-${vencimentoProximo.getTime()}`,
        reference: `Mensalidade Sistema - ${vencimentoProximo.toLocaleString('pt-BR', { month: 'long', year: 'numeric' }).toUpperCase()}`,
        amount: valorMensalidade,
        dueDate: vencimentoProximo.toISOString(),
        status: store.isActive === false ? 'OVERDUE' : 'PENDING',
        pdfUrl: 'https://www.cora.com.br/boleto-simulado.pdf' // ⬅️ Aqui entrará o link do PDF do Cora
      },
      {
        id: `FAT-CORA-${new Date(dataAtual.getFullYear(), dataAtual.getMonth() - 1, 10).getTime()}`,
        reference: `Mensalidade Sistema - ${new Date(dataAtual.getFullYear(), dataAtual.getMonth() - 1, 10).toLocaleString('pt-BR', { month: 'long', year: 'numeric' }).toUpperCase()}`,
        amount: valorMensalidade,
        dueDate: new Date(dataAtual.getFullYear(), dataAtual.getMonth() - 1, 10).toISOString(),
        status: 'PAID',
        pdfUrl: 'https://www.cora.com.br/boleto-simulado.pdf'
      }
    ];

    res.json({ 
      success: true, 
      store: store,
      invoices: mockInvoices,
      nextPaymentDate: vencimentoProximo.toISOString()
    });

  } catch (error) {
    console.error('ERRO GET STORE INFO:', error);
    res.status(500).json({ success: false, error: 'Erro interno no servidor ao buscar dados da empresa.' });
  }
});

// ============================================================================
// BLOQUEAR / DESBLOQUEAR LOJA (Botão de Status na Tabela)
// ============================================================================
app.put('/api/master/lojas/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const isActive = status === 'ACTIVE';
    const dbModel = prisma.loja || prisma.store;

    const lojaAtualizada = await dbModel.update({
      where: { id: req.params.id },
      data: { status, isActive }
    });

    res.json({ success: true, loja: lojaAtualizada });
  } catch (error) {
    console.error('ERRO AO ALTERAR STATUS DA LOJA:', error);
    res.status(500).json({ success: false, error: 'Erro interno ao tentar bloquear/desbloquear a loja.' });
  }
});

// ============================================================================
// EDITAR DADOS DA LOJA E VINCULAR FRANQUEADO 
// ============================================================================
app.put('/api/master/lojas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const dbModel = prisma.loja || prisma.store;
    if (!dbModel) throw new Error("Tabela de Lojas não encontrada no Prisma.");

    const dataToUpdate = {};
    //'endereco' adicionado na lista de campos permitidos
    const allowedFields = [
      'slug', 'razaoSocial', 'cnpj', 'inscricaoEstadual', 'inscricaoMunicipal', 
      'emailEmpresa', 'telefoneEmpresa', 'nomeResponsavel', 'cpfResponsavel', 
      'emailResponsavel', 'endereco', 'logoUrl', 'plan'
    ];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        dataToUpdate[field] = req.body[field];
      }
    });

    if (req.body.monthlyFee !== undefined) {
      dataToUpdate.monthlyFee = Number(req.body.monthlyFee || 0);
    }

    if (req.body.senhaResponsavel && req.body.senhaResponsavel.trim() !== '') {
      dataToUpdate.senhaResponsavel = req.body.senhaResponsavel;
    }

    if (req.body.adminUserId !== undefined) {
      dataToUpdate.adminUserId = (req.body.adminUserId === '' || req.body.adminUserId === 'null' || !req.body.adminUserId) 
        ? null 
        : req.body.adminUserId;
    }

    const updatedLoja = await dbModel.update({
      where: { id },
      data: dataToUpdate
    });

    res.json({ success: true, loja: updatedLoja });
  } catch (error) {
    console.error("🔥 ERRO FATAL AO EDITAR LOJA:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message || "Erro desconhecido no banco de dados" 
    });
  }
});

// ==============================================================
// 4. CONFIGURAÇÕES, IMPRESSORAS E MÓDULOS DE CADASTRO GERAL
// ==============================================================

app.get("/api/printers", async (req, res) => {
    try {
        res.json(
            await prisma.printer.findMany({ where: { lojaId: req.lojaId } })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.post("/api/printers", async (req, res) => {
    try {
        res.status(201).json({
            success: true,
            printer: await prisma.printer.create({
                data: { ...req.body, lojaId: req.lojaId },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.put("/api/printers/:id", async (req, res) => {
    try {
        res.json({
            success: true,
            printer: await prisma.printer.update({
                where: { id: req.params.id },
                data: req.body,
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.delete("/api/printers/:id", async (req, res) => {
    try {
        await prisma.printer.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/product-groups", async (req, res) => {
    try {
        res.json(
            await prisma.productGroup.findMany({
                where: { lojaId: req.lojaId },
                include: { printer: true },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.post("/api/product-groups", async (req, res) => {
    try {
        res.status(201).json({
            success: true,
            group: await prisma.productGroup.create({
                data: { ...req.body, lojaId: req.lojaId },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.put("/api/product-groups/:id", async (req, res) => {
    try {
        res.json({
            success: true,
            group: await prisma.productGroup.update({
                where: { id: req.params.id },
                data: req.body,
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.delete("/api/product-groups/:id", async (req, res) => {
    try {
        await prisma.productGroup.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/settings", async (req, res) => {
    const isOpen = await checkStoreStatus(req.lojaId);
    res.json({ 
        ...(await getSettings(req.lojaId)), 
        isOpen,
        success: true,
        store: req.lojaInfo
    });
});

app.put("/api/settings", async (req, res) => {
    try {
        const currentSettings = await getSettings(req.lojaId);
        const newSettings = { ...currentSettings, ...req.body };
        
        // INTELIGÊNCIA: Sincroniza o logo com a tabela principal para o Painel Master e o App lerem corretamente!
        if (req.body.logoUrl !== undefined) {
            await prisma.loja.update({
                where: { id: req.lojaId },
                data: { logoUrl: req.body.logoUrl }
            }).catch(() => {}); // Ignora se não houver mudança
        }

        await prisma.systemConfig.upsert({
            where: { key_lojaId: { key: "settings", lojaId: req.lojaId } },
            update: { data: JSON.stringify(newSettings) },
            create: {
                key: "settings",
                lojaId: req.lojaId,
                data: JSON.stringify(newSettings),
            },
        });
        res.json({ success: true, settings: newSettings });
    } catch (error) {
        res.status(500).json({ error: "Erro DB" });
    }
});

// Configurações Fiscais e Certificado
app.get("/api/fiscal", async (req, res) =>
    res.json(await getFiscalData(req.lojaId))
);
app.put("/api/fiscal", async (req, res) => {
    try {
        const currentFiscal = await getFiscalData(req.lojaId);
        const newFiscal = { ...currentFiscal, ...req.body };
        await prisma.systemConfig.upsert({
            where: { key_lojaId: { key: "fiscal", lojaId: req.lojaId } },
            update: { data: JSON.stringify(newFiscal) },
            create: {
                key: "fiscal",
                lojaId: req.lojaId,
                data: JSON.stringify(newFiscal),
            },
        });
        res.json({ success: true, fiscalData: newFiscal });
    } catch (error) {
        res.status(500).json({ error: "Erro DB" });
    }
});

app.get("/api/fiscal/certificado/status", async (req, res) => {
    try {
        const certConfig = await prisma.systemConfig.findUnique({
            where: {
                key_lojaId: { key: "certificado_a1", lojaId: req.lojaId },
            },
        });
        if (certConfig) {
            const data = JSON.parse(certConfig.data);
            res.json({
                cadastrado: true,
                nomeArquivo: data.nomeArquivo,
                dataUpload: data.dataUpload,
            });
        } else res.json({ cadastrado: false });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});
app.post("/api/fiscal/certificado", upload.single("certificado"), async (req, res) => {
        try {
            const file = req.file;
            const senha = req.body.senha;
            if (!file || !senha)
                return res.status(400).json({ error: "Obrigatórios." });
            const certData = {
                nomeArquivo: file.originalname,
                dataUpload: new Date().toISOString(),
                base64: file.buffer.toString("base64"),
                senha: senha,
            };
            await prisma.systemConfig.upsert({
                where: {
                    key_lojaId: { key: "certificado_a1", lojaId: req.lojaId },
                },
                update: { data: JSON.stringify(certData) },
                create: {
                    key: "certificado_a1",
                    lojaId: req.lojaId,
                    data: JSON.stringify(certData),
                },
            });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: "Erro" });
        }
    }
);
app.delete('/api/fiscal/certificado', async (req, res) => {
    try {
        if (!req.lojaId) return res.status(400).json({ error: 'Loja não identificada.' });

        //Apaga o certificado da tabela SystemConfig usando a chave correta
        await prisma.systemConfig.delete({
            where: { 
                key_lojaId: { 
                    key: "certificado_a1", 
                    lojaId: req.lojaId 
                } 
            }
        });

        res.json({ success: true, message: 'Certificado removido com sucesso.' });
    } catch (error) {
        console.error('ERRO AO EXCLUIR CERTIFICADO:', error);
        
        // Se o Prisma disser que o arquivo já não existe (Erro P2025), retorna sucesso para destravar a tela
        if (error.code === 'P2025') {
            return res.json({ success: true, message: 'Certificado já havia sido removido.' });
        }
        
        res.status(500).json({ error: 'Erro interno ao tentar remover o certificado.' });
    }
});

// Outros JSON Configs
app.get("/api/upsells", async (req, res) => {
    const ups = await getUpsells(req.lojaId);
    res.json(ups.filter((u) => u.active));
});
app.get("/api/admin/upsells", async (req, res) =>
    res.json(await getUpsells(req.lojaId))
);
app.post("/api/admin/upsells", async (req, res) => {
    try {
        const upsells = await getUpsells(req.lojaId);
        const newUpsell = {
            id: Date.now().toString(),
            ...req.body,
            active: true,
        };
        upsells.push(newUpsell);
        await prisma.systemConfig.upsert({
            where: { key_lojaId: { key: "upsells", lojaId: req.lojaId } },
            update: { data: JSON.stringify(upsells) },
            create: {
                key: "upsells",
                lojaId: req.lojaId,
                data: JSON.stringify(upsells),
            },
        });
        res.json({ success: true, upsell: newUpsell });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.put("/api/admin/upsells/:id", async (req, res) => {
    try {
        const upsells = await getUpsells(req.lojaId);
        const idx = upsells.findIndex((u) => u.id === req.params.id);
        if (idx > -1) {
            upsells[idx] = { ...upsells[idx], ...req.body };
            await prisma.systemConfig.update({
                where: { key_lojaId: { key: "upsells", lojaId: req.lojaId } },
                data: { data: JSON.stringify(upsells) },
            });
            res.json({ success: true, upsell: upsells[idx] });
        } else res.status(404).json({ error: "Erro" });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.delete("/api/admin/upsells/:id", async (req, res) => {
    try {
        let upsells = await getUpsells(req.lojaId);
        upsells = upsells.filter((u) => u.id !== req.params.id);
        await prisma.systemConfig.update({
            where: { key_lojaId: { key: "upsells", lojaId: req.lojaId } },
            data: { data: JSON.stringify(upsells) },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/suppliers", async (req, res) =>
    res.json(await getSuppliers(req.lojaId))
);
app.post("/api/admin/suppliers", async (req, res) => {
    try {
        const suppliers = await getSuppliers(req.lojaId);
        const newSupplier = {
            id: Date.now().toString(),
            ...req.body,
            active: true,
        };
        suppliers.push(newSupplier);
        await prisma.systemConfig.upsert({
            where: { key_lojaId: { key: "suppliers", lojaId: req.lojaId } },
            update: { data: JSON.stringify(suppliers) },
            create: {
                key: "suppliers",
                lojaId: req.lojaId,
                data: JSON.stringify(suppliers),
            },
        });
        res.json({ success: true, supplier: newSupplier });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});
app.put("/api/admin/suppliers/:id", async (req, res) => {
    try {
        const suppliers = await getSuppliers(req.lojaId);
        const idx = suppliers.findIndex((s) => s.id === req.params.id);
        if (idx > -1) {
            suppliers[idx] = { ...suppliers[idx], ...req.body };
            await prisma.systemConfig.update({
                where: { key_lojaId: { key: "suppliers", lojaId: req.lojaId } },
                data: { data: JSON.stringify(suppliers) },
            });
            res.json({ success: true, supplier: suppliers[idx] });
        } else res.status(404).json({ error: "Erro" });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});
app.delete("/api/admin/suppliers/:id", async (req, res) => {
    try {
        let suppliers = await getSuppliers(req.lojaId);
        suppliers = suppliers.filter((s) => s.id !== req.params.id);
        await prisma.systemConfig.update({
            where: { key_lojaId: { key: "suppliers", lojaId: req.lojaId } },
            data: { data: JSON.stringify(suppliers) },
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/admin/coupons", async (req, res) =>
    res.json(await getCoupons(req.lojaId))
);
app.post("/api/admin/coupons", async (req, res) => {
    try {
        const { code, type, value, minOrderValue, active, maxUses } = req.body;
        if (!code || !type || !value)
            return res.status(400).json({ error: "Erro" });

        const coupons = await getCoupons(req.lojaId);
        const newCoupon = {
            code: code.toUpperCase(),
            type,
            value: Number(value),
            minOrderValue: Number(minOrderValue || 0),
            maxUses: Number(maxUses || 0),
            active: active !== false,
            usedCount: 0,
            usedBy: [],
        };
        const existingIndex = coupons.findIndex(
            (c) => c.code === newCoupon.code
        );
        if (existingIndex >= 0) {
            coupons[existingIndex] = {
                ...coupons[existingIndex],
                ...newCoupon,
                usedCount: coupons[existingIndex].usedCount,
                usedBy: coupons[existingIndex].usedBy || [],
            };
        } else coupons.push(newCoupon);

        await prisma.systemConfig.upsert({
            where: { key_lojaId: { key: "coupons", lojaId: req.lojaId } },
            update: { data: JSON.stringify(coupons) },
            create: {
                key: "coupons",
                lojaId: req.lojaId,
                data: JSON.stringify(coupons),
            },
        });
        res.json({ success: true, coupon: newCoupon });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.post("/api/coupons/validate", async (req, res) => {
    const { code, cartTotal, clientId } = req.body;
    if (!code) return res.status(400).json({ error: "Código" });
    const coupons = await getCoupons(req.lojaId);
    const coupon = coupons.find((c) => c.code === code.toUpperCase());
    if (!coupon || !coupon.active)
        return res.status(404).json({ error: "Inválido" });
    if (cartTotal < coupon.minOrderValue)
        return res
            .status(400)
            .json({ error: `Minimo: R$ ${coupon.minOrderValue.toFixed(2)}.` });
    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses)
        return res.status(400).json({ error: "Esgotado." });
    if (clientId && coupon.usedBy && coupon.usedBy.includes(clientId))
        return res.status(400).json({ error: "Já utilizado." });
    res.json({ success: true, coupon });
});

// ==============================================================
// LER E SALVAR PERFIL DO ADMINISTRADOR / FUNCIONÁRIO
// ==============================================================
app.get("/api/auth/admin/profile/:id", async (req, res) => {
    try {
        const emp = await prisma.employee.findUnique({ where: { id: req.params.id } });
        if (emp && emp.lojaId === req.lojaId) {
            res.json({ success: true, profile: { name: emp.name, email: emp.email } });
        } else {
            res.status(404).json({ error: "Perfil não encontrado" });
        }
    } catch (e) {
        res.status(500).json({ error: "Erro ao buscar perfil" });
    }
});

app.put("/api/auth/admin/profile/:id", async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const dataToUpdate = { name, email };
        if (password && password.trim() !== '') {
            dataToUpdate.password = await bcrypt.hash(password, 10);
        }
        const updated = await prisma.employee.update({
            where: { id: req.params.id },
            data: dataToUpdate
        });
        res.json({ success: true, profile: { name: updated.name, email: updated.email } });
    } catch (e) {
        res.status(500).json({ error: "Erro ao atualizar perfil" });
    }
});

// ==============================================================
// 5. AUTENTICAÇÃO E USUÁRIOS
// ==============================================================

app.post("/api/auth/employee/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const employee = await prisma.employee.findFirst({
            where: {
                lojaId: req.lojaId,
                OR: [{ email: email }, { cpf: email }],
            },
            include: { profile: true },
        });
        if (!employee || !(await bcrypt.compare(password, employee.password)))
            return res.status(401).json({ error: "Login inválido." });
        if (!employee.isActive)
            return res.status(403).json({ error: "Conta inativa." });

        if (
            employee.role.toLowerCase().includes("entregador") &&
            employee.facePhoto
        ) {
            const today = new Date().toISOString().split("T")[0];
            const lastLogin = employee.lastFaceLogin
                ? new Date(employee.lastFaceLogin).toISOString().split("T")[0]
                : null;
            if (lastLogin !== today)
                return res.json({
                    success: true,
                    needsFaceValidation: true,
                    employeeId: employee.id,
                });
        }
        const token = jwt.sign(
            {
                id: employee.id,
                lojaId: employee.lojaId,
                role: "EMPLOYEE",
                profile: employee.role,
                permissions: JSON.parse(employee.profile.permissions),
            },
            JWT_SECRET,
            { expiresIn: "12h" }
        );
        res.status(200).json({
            success: true,
            token,
            employee: {
                id: employee.id,
                name: employee.name,
                role: employee.role,
                permissions: JSON.parse(employee.profile.permissions),
                loja: req.lojaInfo,
            },
        });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/auth/employee/face-login-verify", async (req, res) => {
    const { employeeId, currentFacePhoto } = req.body;
    try {
        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            include: { profile: true },
        });
        if (!employee || employee.lojaId !== req.lojaId)
            return res
                .status(404)
                .json({ error: "Funcionário não encontrado." });
        if (!employee.facePhoto)
            return res.status(400).json({ error: "Nenhuma foto." });

        const base64Photo1 = employee.facePhoto.replace(
            /^data:image\/\w+;base64,/,
            ""
        );
        const base64Photo2 = currentFacePhoto.replace(
            /^data:image\/\w+;base64,/,
            ""
        );
        const buffer1 = Buffer.from(base64Photo1, "base64");
        const buffer2 = Buffer.from(base64Photo2, "base64");
        const blob1 = new Blob([buffer1], { type: "image/jpeg" });
        const blob2 = new Blob([buffer2], { type: "image/jpeg" });
        const formData = new FormData();
        formData.append("photo1", blob1, "photo1.jpg");
        formData.append("photo2", blob2, "photo2.jpg");

        const luxandRes = await fetch(
            "https://api.luxand.cloud/v2/faces/compare",
            {
                method: "POST",
                headers: { token: process.env.LUXAND_API_TOKEN },
                body: formData,
            }
        );
        const luxandData = await luxandRes.json();
        if (luxandData.probability && luxandData.probability >= 0.8) {
            await prisma.employee.update({
                where: { id: employeeId },
                data: { lastFaceLogin: new Date() },
            });
            const token = jwt.sign(
                {
                    id: employee.id,
                    lojaId: employee.lojaId,
                    role: "EMPLOYEE",
                    profile: employee.role,
                    permissions: JSON.parse(employee.profile.permissions),
                },
                JWT_SECRET,
                { expiresIn: "12h" }
            );
            res.json({
                success: true,
                token,
                employee: {
                    id: employee.id,
                    name: employee.name,
                    role: employee.role,
                    permissions: JSON.parse(employee.profile.permissions),
                    loja: req.lojaInfo,
                },
            });
        } else {
            res.status(401).json({ error: `Rosto não confere.` });
        }
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/auth/register", async (req, res) => {
    const { name, email, password, phone, cpf, birthDate, address } = req.body;
    try {
        const existingUser = await prisma.user.findUnique({
            where: { email_lojaId: { email, lojaId: req.lojaId } },
        });
        if (existingUser)
            return res
                .status(400)
                .json({ error: "Este e-mail já está em uso nesta loja." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await prisma.user.create({
            data: {
                lojaId: req.lojaId,
                name,
                email,
                password: hashedPassword,
                phone,
                cpf,
                birthDate,
                address,
                role: "CLIENT",
                cashback: { create: { balance: 0.0, lojaId: req.lojaId } },
            },
            include: { cashback: true },
        });
        res.status(201).json({
            success: true,
            token: jwt.sign(
                { id: newUser.id, role: newUser.role, lojaId: req.lojaId },
                JWT_SECRET,
                { expiresIn: "7d" }
            ),
            user: newUser,
        });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await prisma.user.findUnique({
            where: { email_lojaId: { email, lojaId: req.lojaId } },
            include: {
                cashback: true,
                orders: { orderBy: { createdAt: "desc" }, take: 1 },
            },
        });
        if (!user || !(await bcrypt.compare(password, user.password)))
            return res
                .status(401)
                .json({ error: "E-mail ou senha inválidos." });
        if (user.isBlocked)
            return res.status(403).json({ error: "Conta bloqueada." });

        const lastAddress =
            user.orders.length > 0 ? user.orders[0].address : "";
        res.status(200).json({
            success: true,
            token: jwt.sign(
                { id: user.id, role: user.role, lojaId: req.lojaId },
                JWT_SECRET,
                { expiresIn: "7d" }
            ),
            user: { ...user, lastAddress },
        });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/users/:id", async (req, res) => {
    const { name, email, password, phone, cpf, birthDate, address } = req.body;
    try {
        const dataToUpdate = { name, email, phone, cpf, birthDate, address };
        if (password && password.trim() !== "")
            dataToUpdate.password = await bcrypt.hash(password, 10);
        const updatedUser = await prisma.user.update({
            where: { id: req.params.id },
            data: dataToUpdate,
            include: { cashback: true },
        });
        res.json({ success: true, user: updatedUser });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/auth/forgot-password", async (req, res) => {
    const { email } = req.body;
    try {
        const user = await prisma.user.findUnique({
            where: { email_lojaId: { email, lojaId: req.lojaId } },
        });
        if (!user)
            return res.status(404).json({ error: "Nenhuma conta encontrada" });
        const resetCode = Math.floor(
            100000 + Math.random() * 900000
        ).toString();
        const resetCodeExpires = new Date(Date.now() + 15 * 60 * 1000);
        await prisma.user.update({
            where: { id: user.id },
            data: { resetCode, resetCodeExpires },
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/auth/reset-password", async (req, res) => {
    const { email, code, newPassword } = req.body;
    try {
        const user = await prisma.user.findUnique({
            where: { email_lojaId: { email, lojaId: req.lojaId } },
        });
        if (!user || user.resetCode !== code)
            return res.status(400).json({ error: "Inválido" });
        if (user.resetCodeExpires < new Date())
            return res.status(400).json({ error: "Expirou" });
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                resetCode: null,
                resetCodeExpires: null,
            },
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/customers", async (req, res) => {
    try {
        res.json(
            await prisma.user.findMany({
                where: { lojaId: req.lojaId, role: "CLIENT" },
                include: {
                    cashback: true,
                    orders: {
                        select: { id: true, address: true },
                        orderBy: { createdAt: "desc" },
                    },
                    accountMovements: true,
                },
                orderBy: { createdAt: "desc" },
            })
        );
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/admin/customers/:id", async (req, res) => {
    const { name, email, password, phone, cpf, birthDate, address } = req.body;
    try {
        const dataToUpdate = { name, email, phone, cpf, birthDate, address };
        if (password && password.trim() !== "")
            dataToUpdate.password = await bcrypt.hash(password, 10);
        await prisma.user.update({
            where: { id: req.params.id },
            data: dataToUpdate,
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/admin/customers/:id/block", async (req, res) => {
    try {
        await prisma.user.update({
            where: { id: req.params.id },
            data: { isBlocked: req.body.isBlocked },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/crm/customer-accounts", async (req, res) => {
    try {
        const customers = await prisma.user.findMany({
            where: {
                lojaId: req.lojaId,
                role: "CLIENT",
                accountMovements: { some: {} },
            },
            include: { accountMovements: { orderBy: { createdAt: "desc" } } },
            orderBy: { name: "asc" },
        });
        const accountsData = customers
            .map((c) => {
                const pending = c.accountMovements.filter(
                    (m) => m.type === "CHARGE" && !m.isPaid
                );
                const currentDebt = pending.reduce(
                    (acc, curr) => acc + curr.amount,
                    0
                );
                return { ...c, currentDebt, pendingCount: pending.length };
            })
            .filter((c) => c.currentDebt > 0 || c.isBlocked);
        res.json(accountsData);
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/crm/customer-accounts/pay", async (req, res) => {
    const { customerId } = req.body;
    try {
        const pending = await prisma.customerAccountMovement.findMany({
            where: {
                lojaId: req.lojaId,
                customerId,
                type: "CHARGE",
                isPaid: false,
            },
        });
        const totalToPay = pending.reduce((acc, curr) => acc + curr.amount, 0);
        if (totalToPay <= 0)
            return res.status(400).json({ error: "Sem dívidas." });
        await prisma.$transaction([
            prisma.customerAccountMovement.updateMany({
                where: {
                    lojaId: req.lojaId,
                    customerId,
                    type: "CHARGE",
                    isPaid: false,
                },
                data: { isPaid: true, paidAt: new Date() },
            }),
            prisma.customerAccountMovement.create({
                data: {
                    lojaId: req.lojaId,
                    customerId,
                    type: "PAYMENT",
                    amount: totalToPay,
                    description: `Acerto de Conta Pendente`,
                    isPaid: true,
                    paidAt: new Date(),
                },
            }),
            prisma.user.update({
                where: { id: customerId },
                data: { isBlocked: false },
            }),
        ]);
        res.json({ success: true, message: "Pago" });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/avaliacoes", async (req, res) => {
    try {
        res.json(
            await prisma.avaliacao.findMany({
                where: { lojaId: req.lojaId },
                orderBy: { dataCriacao: "desc" },
                take: 10,
            })
        );
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});
app.post("/api/avaliacoes", async (req, res) => {
    try {
        const { clienteNome, nota, comentario } = req.body;
        if (!clienteNome || !nota)
            return res.status(400).json({ success: false, error: "Erro" });
        const novaAvaliacao = await prisma.avaliacao.create({
            data: {
                lojaId: req.lojaId,
                clienteNome,
                nota: Number(nota),
                comentario: comentario || "",
            },
        });
        res.json({ success: true, avaliacao: novaAvaliacao });
    } catch (error) {
        res.status(500).json({ success: false, error: "Erro" });
    }
});

// RH E PERFIS
app.get("/api/rh/profiles", async (req, res) => {
    try {
        res.json(
            await prisma.accessProfile.findMany({
                where: { lojaId: req.lojaId },
                orderBy: { name: "asc" },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/rh/profiles", async (req, res) => {
    const { name, permissions } = req.body;
    try {
        const existing = await prisma.accessProfile.findUnique({
            where: { name_lojaId: { name, lojaId: req.lojaId } },
        });
        if (existing) return res.status(400).json({ error: "Já existe." });
        res.status(201).json({
            success: true,
            profile: await prisma.accessProfile.create({
                data: {
                    lojaId: req.lojaId,
                    name,
                    permissions: JSON.stringify(permissions || []),
                },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/rh/profiles/:id", async (req, res) => {
    const { name, permissions } = req.body;
    try {
        const existing = await prisma.accessProfile.findUnique({
            where: { name_lojaId: { name, lojaId: req.lojaId } },
        });
        if (existing && existing.id !== req.params.id)
            return res.status(400).json({ error: "Já existe." });
        res.json({
            success: true,
            profile: await prisma.accessProfile.update({
                where: { id: req.params.id },
                data: { name, permissions: JSON.stringify(permissions || []) },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.delete("/api/rh/profiles/:id", async (req, res) => {
    try {
        const checkEmployees = await prisma.employee.count({
            where: { profileId: req.params.id },
        });
        if (checkEmployees > 0)
            return res
                .status(400)
                .json({ error: "Tem funcionários vinculados." });
        await prisma.accessProfile.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/rh/employees", async (req, res) => {
    try {
        res.json(
            await prisma.employee.findMany({
                where: { lojaId: req.lojaId },
                include: { profile: true },
                orderBy: { name: "asc" },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/rh/employees", async (req, res) => {
    const {
        name,
        cpf,
        age,
        address,
        email,
        phone,
        password,
        profileId,
        receivesTips,
        creditLimit,
        discountPercent,
    } = req.body;
    try {
        const checkEmail = await prisma.employee.findUnique({
            where: { email_lojaId: { email, lojaId: req.lojaId } },
        });
        if (checkEmail)
            return res.status(400).json({ error: "E-mail em uso." });
        const checkCpf = await prisma.employee.findUnique({
            where: { cpf_lojaId: { cpf, lojaId: req.lojaId } },
        });
        if (checkCpf) return res.status(400).json({ error: "CPF em uso." });
        const profileInfo = await prisma.accessProfile.findUnique({
            where: { id: profileId },
        });
        if (!profileInfo)
            return res.status(400).json({ error: "Perfil inválido." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newEmployee = await prisma.employee.create({
            data: {
                lojaId: req.lojaId,
                name,
                cpf,
                age: String(age),
                address,
                email,
                phone,
                password: hashedPassword,
                role: profileInfo.name,
                profileId,
                isActive: true,
                receivesTips: Boolean(receivesTips),
                creditLimit: Number(creditLimit),
                discountPercent: Number(discountPercent),
            },
            include: { profile: true },
        });
        res.status(201).json({ success: true, employee: newEmployee });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/rh/employees/:id", async (req, res) => {
    const {
        name,
        cpf,
        age,
        address,
        email,
        phone,
        password,
        profileId,
        isActive,
        receivesTips,
        creditLimit,
        discountPercent,
    } = req.body;
    try {
        const profileInfo = await prisma.accessProfile.findUnique({
            where: { id: profileId },
        });
        const updateData = {
            name,
            cpf,
            age: String(age),
            address,
            email,
            phone,
            isActive,
            profileId,
            role: profileInfo.name,
            receivesTips: Boolean(receivesTips),
            creditLimit: Number(creditLimit),
            discountPercent: Number(discountPercent),
        };
        if (password && password.trim() !== "")
            updateData.password = await bcrypt.hash(password, 10);
        res.json({
            success: true,
            employee: await prisma.employee.update({
                where: { id: req.params.id },
                data: updateData,
                include: { profile: true },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro ao atualizar funcionário" });
    }
});

app.post("/api/rh/delivery-persons/register", async (req, res) => {
    const { name, cpf, email, phone, password, facePhoto } = req.body;
    try {
        const checkEmail = await prisma.employee.findUnique({
            where: { email_lojaId: { email, lojaId: req.lojaId } },
        });
        if (checkEmail)
            return res.status(400).json({ error: "E-mail em uso." });
        const checkCpf = await prisma.employee.findUnique({
            where: { cpf_lojaId: { cpf, lojaId: req.lojaId } },
        });
        if (checkCpf) return res.status(400).json({ error: "CPF em uso." });
        let profileInfo = await prisma.accessProfile.findFirst({
            where: {
                lojaId: req.lojaId,
                name: { contains: "Entregador", mode: "insensitive" },
            },
        });
        if (!profileInfo) {
            profileInfo = await prisma.accessProfile.create({
                data: {
                    lojaId: req.lojaId,
                    name: "Entregador",
                    permissions: "[]",
                },
            });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await prisma.employee.create({
            data: {
                lojaId: req.lojaId,
                name,
                cpf,
                email,
                phone,
                password: hashedPassword,
                role: profileInfo.name,
                profileId: profileInfo.id,
                facePhoto,
                isActive: true,
            },
        });
        res.status(201).json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/rh/logs", async (req, res) => {
    const { employeeId, action, details } = req.body;
    try {
        await prisma.employeeLog.create({
            data: {
                lojaId: req.lojaId,
                employeeId,
                action,
                details: details || "",
            },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/rh/logs", async (req, res) => {
    try {
        res.json(
            await prisma.employeeLog.findMany({
                where: { lojaId: req.lojaId },
                include: { employee: { select: { name: true, role: true } } },
                orderBy: { createdAt: "desc" },
                take: 200,
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/rh/employee-accounts", async (req, res) => {
    try {
        const employees = await prisma.employee.findMany({
            where: { lojaId: req.lojaId },
            include: { accountMovements: { orderBy: { createdAt: "desc" } } },
            orderBy: { name: "asc" },
        });
        const now = new Date();
        let cutoff = new Date(now.getFullYear(), now.getMonth(), 26);
        if (now.getDate() < 26)
            cutoff = new Date(now.getFullYear(), now.getMonth() - 1, 26);
        const accountsData = employees.map((emp) => {
            const pending = emp.accountMovements.filter(
                (m) => m.type === "CHARGE" && !m.isPaid
            );
            const currentDebt = pending.reduce(
                (acc, curr) => acc + curr.amount,
                0
            );
            const hasOverdue = pending.some(
                (c) => new Date(c.createdAt) < cutoff
            );
            const availableLimit = emp.creditLimit - currentDebt;
            return {
                ...emp,
                currentDebt,
                availableLimit,
                hasOverdue,
                pendingCount: pending.length,
            };
        });
        res.json(accountsData);
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/rh/employee-accounts/pay", async (req, res) => {
    const { employeeId, authData } = req.body;
    try {
        const admin = await prisma.employee.findFirst({
            where: {
                lojaId: req.lojaId,
                OR: [{ email: authData.email }, { cpf: authData.email }],
            },
            include: { profile: true },
        });
        if (
            !admin ||
            !(await bcrypt.compare(authData.password, admin.password))
        )
            return res.status(401).json({ error: "Credenciais inválidas." });

        const pending = await prisma.employeeAccountMovement.findMany({
            where: {
                lojaId: req.lojaId,
                employeeId,
                type: "CHARGE",
                isPaid: false,
            },
        });
        const totalToPay = pending.reduce((acc, curr) => acc + curr.amount, 0);
        if (totalToPay <= 0)
            return res.status(400).json({ error: "Sem dívidas." });
        await prisma.$transaction([
            prisma.employeeAccountMovement.updateMany({
                where: {
                    lojaId: req.lojaId,
                    employeeId,
                    type: "CHARGE",
                    isPaid: false,
                },
                data: { isPaid: true, paidAt: new Date() },
            }),
            prisma.employeeAccountMovement.create({
                data: {
                    lojaId: req.lojaId,
                    employeeId,
                    type: "PAYMENT",
                    amount: totalToPay,
                    description: `Acerto Mensal. Aut. por ${admin.name}`,
                    isPaid: true,
                    paidAt: new Date(),
                },
            }),
        ]);
        res.json({ success: true, message: "Pago!" });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

// ==============================================================
// 6. MENU, CATEGORIAS, PRODUTOS, INSUMOS, FICHAS TÉCNICAS
// ==============================================================

app.get("/api/menu", async (req, res) => {
    try {
        res.json(
            await prisma.category.findMany({
                where: { lojaId: req.lojaId },
                orderBy: { order: "asc" },
                include: {
                    products: {
                        where: { isActive: true },
                        orderBy: { order: "asc" },
                        include: { 
                            comboItemsAsParent: true 
                        }
                    },
                },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/categories/reorder", async (req, res) => {
    const { categories } = req.body;
    try {
        for (let cat of categories) {
            await prisma.category.updateMany({
                where: { id: cat.id, lojaId: req.lojaId },
                data: { order: cat.order },
            });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/products/reorder", async (req, res) => {
    const { products } = req.body;
    try {
        for (let prod of products) {
            await prisma.product.updateMany({
                where: { id: prod.id, lojaId: req.lojaId },
                data: { order: prod.order },
            });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

//Rota exclusiva para adicionar/remover o produto do Carrossel (Destaque)
app.put("/api/products/:id/feature", async (req, res) => {
    try {
        const { isFeatured } = req.body;
        
        // Atualiza apenas o campo isFeatured no banco de dados
        const updatedProduct = await prisma.product.update({
            where: { id: req.params.id },
            data: { 
                isFeatured: Boolean(isFeatured) 
            },
        });

        res.json({ success: true, product: updatedProduct });
    } catch (e) {
        console.error("Erro ao alterar destaque do produto:", e);
        res.status(500).json({ 
            success: false, 
            error: "Erro ao atualizar destaque no banco de dados: " + e.message 
        });
    }
});

app.get("/api/products/highlights", async (req, res) => {
    try {
        res.json(
            await prisma.product.findMany({
                where: { lojaId: req.lojaId, isFeatured: true, isActive: true },
                take: 5,
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/products", async (req, res) => {
    try {
        res.json(
            await prisma.product.findMany({
                where: { lojaId: req.lojaId },
                include: {
                    category: true,
                    fichasTecnicas: { include: { insumo: true } },
                    comboItemsAsParent: true // 👈 Essencial para carregar os itens ao clicar em "Editar"
                },
                orderBy: { createdAt: "desc" },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/products", async (req, res) => {
    const {
        name, description, price, price700g, price1kg, categoryId, imageUrl, regraFiscalId, ncm, ean, groupId,
        isPizza, maxFlavors, pricingStrategy, sizeMultiplier, isCombo, comboItems // 👈 Capturando as novidades da tela
    } = req.body;

    try {
        const newProduct = await prisma.product.create({
            data: {
                lojaId: req.lojaId,
                name,
                description,
                price: Number(price),
                price700g: price700g ? Number(price700g) : null,
                price1kg: price1kg ? Number(price1kg) : null,
                categoryId,
                imageUrl,
                regraFiscalId,
                ncm,
                ean,
                groupId: groupId || null,
                isActive: true,
                
                // 🍕 Salvando configs de Pizza
                isPizza: Boolean(isPizza),
                maxFlavors: maxFlavors ? Number(maxFlavors) : 1,
                pricingStrategy: pricingStrategy || "HIGHEST",
                sizeMultiplier: sizeMultiplier ? Number(sizeMultiplier) : 1.0,
                
                // 🍔 Salvando configs de Combo
                isCombo: Boolean(isCombo),
                comboItemsAsParent: (isCombo && comboItems && comboItems.length > 0) ? {
                    create: comboItems.map(item => ({
                        productId: item.productId,
                        quantity: Number(item.quantity),
                        lojaId: req.lojaId
                    }))
                } : undefined
            },
        });
        res.status(201).json({ success: true, product: newProduct });
    } catch (e) {
        console.error("Erro ao criar produto:", e);
        res.status(500).json({ error: "Erro ao salvar o produto no banco de dados." });
    }
});

app.put("/api/products/:id", async (req, res) => {
    try {
        const {
            name, description, price, price700g, price1kg, categoryId, isActive, imageUrl, isFeatured, regraFiscalId, ncm, ean, groupId,
            isPizza, maxFlavors, pricingStrategy, sizeMultiplier, isCombo, comboItems
        } = req.body;

        // 1. LIMPEZA SEGURA: Apaga os itens antigos do combo para recriar sem erros de duplicação
        await prisma.comboItem.deleteMany({
            where: { comboId: req.params.id }
        });

        // 2. FILTRA OS ITENS DO COMBO (Evita itens duplicados)
        let novosItensCombo = [];
        if (isCombo && comboItems && comboItems.length > 0) {
            const seen = new Set();
            for (const item of comboItems) {
                if (!seen.has(item.productId)) {
                    seen.add(item.productId);
                    novosItensCombo.push({
                        productId: item.productId,
                        quantity: Number(item.quantity) || 1,
                        lojaId: req.lojaId
                    });
                }
            }
        }

        // 3. ATUALIZAÇÃO NO BANCO (Salvando explicitamente as configurações de Pizza e Combo)
        const updated = await prisma.product.update({
            where: { id: req.params.id },
            data: {
                name,
                description: description || null,
                price: Number(price) || 0,
                price700g: price700g ? Number(price700g) : null,
                price1kg: price1kg ? Number(price1kg) : null,
                categoryId,
                isActive: Boolean(isActive),
                imageUrl: imageUrl || null,
                isFeatured: Boolean(isFeatured),
                regraFiscalId: regraFiscalId || null,
                ncm: ncm || null,
                ean: ean || null,
                groupId: groupId || null,
                
                // 🍕 Salvando as propriedades da Pizza
                isPizza: Boolean(isPizza),
                maxFlavors: maxFlavors ? Number(maxFlavors) : 1,
                pricingStrategy: pricingStrategy || "HIGHEST",
                sizeMultiplier: sizeMultiplier !== undefined ? Number(sizeMultiplier) : 1.0,
                
                // 🍔 Salvando as propriedades e os sub-itens do Combo
                isCombo: Boolean(isCombo),
                comboItemsAsParent: novosItensCombo.length > 0 ? {
                    create: novosItensCombo
                } : undefined
            },
        });

        res.json({ success: true, product: updated });
    } catch (e) {
        console.error("Erro ao atualizar produto no servidor:", e);
        res.status(500).json({ success: false, error: "Erro ao atualizar produto no banco de dados: " + e.message });
    }
});

// CATEGORIAS
app.post("/api/categories", async (req, res) => {
    try {
        const count = await prisma.category.count({
            where: { lojaId: req.lojaId },
        });
        res.status(201).json({
            success: true,
            category: await prisma.category.create({
                data: {
                    lojaId: req.lojaId,
                    name: req.body.name,
                    slug: req.body.name
                        .toLowerCase()
                        .normalize("NFD")
                        .replace(/[̀-ͯ]/g, "")
                        .replace(/\s+/g, "-"),
                    order: count,
                    isDrink: Boolean(req.body.isDrink),
                },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/categories/:id", async (req, res) => {
    try {
        res.json({
            success: true,
            category: await prisma.category.update({
                where: { id: req.params.id },
                data: {
                    name: req.body.name,
                    slug: req.body.name
                        .toLowerCase()
                        .normalize("NFD")
                        .replace(/[̀-ͯ]/g, "")
                        .replace(/\s+/g, "-"),
                    isDrink: Boolean(req.body.isDrink),
                },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.delete("/api/categories/:id", async (req, res) => {
    try {
        await prisma.category.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

async function recalcularCustoProduto(productId) {
    try {
        const fichas = await prisma.fichaTecnica.findMany({
            where: { productId },
            include: { insumo: true },
        });
        let novoCusto = 0;
        for (const f of fichas) {
            if (f.insumo && f.insumo.cost)
                novoCusto += f.quantity * Number(f.insumo.cost);
        }
        await prisma.product.update({
            where: { id: productId },
            data: { costPrice: novoCusto },
        });
    } catch (err) {}
}

// ==============================================================
// MOTOR INTELIGENTE DE BAIXA DE ESTOQUE (PIZZAS, COMBOS E NORMAIS)
// ==============================================================
async function processarBaixaDeEstoqueInteligente(orderId, lojaId) {
    try {
        const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { 
                items: { 
                    include: { 
                        product: { 
                            include: { 
                                fichasTecnicas: true, 
                                comboItemsAsParent: { include: { product: { include: { fichasTecnicas: true } } } } 
                            } 
                        } 
                    } 
                } 
            }
        });

        if (!order) return;

        for (const item of order.items) {
            const prod = item.product;

            // 1. É UM COMBO? (Baixa em Cascata)
            if (prod.isCombo && prod.comboItemsAsParent) {
                for (const comboItem of prod.comboItemsAsParent) {
                    const subProduct = comboItem.product;
                    const totalSubItensMultiplicado = item.quantity * comboItem.quantity;
                    
                    // Baixa a ficha técnica de cada subproduto do combo
                    for (const ficha of subProduct.fichasTecnicas) {
                        await abaterInsumo(lojaId, ficha.insumoId, ficha.quantity * totalSubItensMultiplicado, order.shortId);
                    }
                }
            } 
            // 2. É UMA PIZZA MULTI-SABORES? (Baixa Proporcional Fracionada)
            else if (prod.isPizza && item.flavors) {
                const sabores = typeof item.flavors === 'string' ? JSON.parse(item.flavors) : item.flavors;
                const proporcao = 1 / sabores.length; // Ex: 2 sabores = 0.5 (50%), 3 sabores = 0.333 (33.3%)
                const multiplicadorTamanho = prod.sizeMultiplier || 1.0;

                for (const sabor of sabores) {
                    // Busca a ficha técnica específica do sabor escolhido
                    const saborProd = await prisma.product.findUnique({ 
                        where: { id: sabor.productId }, 
                        include: { fichasTecnicas: true }
                    });
                    
                    if (saborProd) {
                        for (const ficha of saborProd.fichasTecnicas) {
                            // Cálculo com Extrema Precisão: Qtd Base * Proporção (Metade/Terço) * Tamanho da Pizza * Qtd de Pizzas Pedidas
                            const qtdCalculada = ficha.quantity * proporcao * multiplicadorTamanho * item.quantity;
                            await abaterInsumo(lojaId, ficha.insumoId, qtdCalculada, order.shortId);
                        }
                    }
                }
            }
            // 3. PRODUTO NORMAL
            else {
                for (const ficha of prod.fichasTecnicas) {
                    await abaterInsumo(lojaId, ficha.insumoId, ficha.quantity * item.quantity, order.shortId);
                }
            }

            // 4. ADICIONAIS / BORDAS RECHEADAS
            if (item.addons) {
                 const addons = typeof item.addons === 'string' ? JSON.parse(item.addons) : item.addons;
                 for (const addon of addons) {
                     if (addon.insumoId) {
                         await abaterInsumo(lojaId, addon.insumoId, addon.quantity * item.quantity, order.shortId);
                     }
                 }
            }
        }
        console.log(`✅ Baixa de estoque inteligente concluída para o pedido #${order.shortId}`);
    } catch (error) {
        console.error("❌ Erro no Motor de Estoque:", error);
    }
}

// Helper para executar a subtração com segurança
async function abaterInsumo(lojaId, insumoId, quantidadeParaAbater, orderShortId) {
    if (quantidadeParaAbater <= 0) return;
    
    await prisma.insumo.update({
        where: { id: insumoId },
        data: { stock: { decrement: quantidadeParaAbater } }
    });

    // Registra no extrato de movimentações
    await prisma.movimentacaoEstoque.create({
        data: {
            lojaId: lojaId,
            insumoId: insumoId,
            type: 'OUT',
            quantity: quantidadeParaAbater,
            reason: `Venda Automática (Pedido #${orderShortId})`
        }
    });
}

app.get("/api/products/:id/fichas", async (req, res) => {
    try {
        res.json(
            await prisma.fichaTecnica.findMany({
                where: { productId: req.params.id, lojaId: req.lojaId },
                include: { insumo: true },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/products/:id/fichas", async (req, res) => {
    try {
        const { insumoId, quantity } = req.body;
        const ficha = await prisma.fichaTecnica.create({
            data: {
                lojaId: req.lojaId,
                productId: req.params.id,
                insumoId,
                quantity: Number(quantity),
            },
            include: { insumo: true },
        });
        await recalcularCustoProduto(req.params.id);
        res.json({ success: true, ficha });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.delete("/api/fichas/:id", async (req, res) => {
    try {
        const ficha = await prisma.fichaTecnica.findUnique({
            where: { id: req.params.id },
        });
        if (ficha) {
            await prisma.fichaTecnica.delete({ where: { id: req.params.id } });
            await recalcularCustoProduto(ficha.productId);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/insumos", async (req, res) => {
    try {
        res.json(
            await prisma.insumo.findMany({
                where: { lojaId: req.lojaId },
                orderBy: { name: "asc" },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/insumos", async (req, res) => {
    try {
        res.status(201).json({
            success: true,
            insumo: await prisma.insumo.create({
                data: {
                    lojaId: req.lojaId,
                    name: req.body.name,
                    unit: req.body.unit,
                    cost: Number(req.body.cost),
                    stock: Number(req.body.stock),
                },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/insumos/:id", async (req, res) => {
    try {
        const insumoAtualizado = await prisma.insumo.update({
            where: { id: req.params.id },
            data: {
                name: req.body.name,
                unit: req.body.unit,
                cost: Number(req.body.cost),
                stock: Number(req.body.stock),
                isActive: req.body.isActive,
            },
        });
        const fichasAfetadas = await prisma.fichaTecnica.findMany({
            where: { insumoId: req.params.id },
        });
        for (const f of fichasAfetadas)
            await recalcularCustoProduto(f.productId);
        res.json({ success: true, insumo: insumoAtualizado });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/estoque/movimentacoes", async (req, res) => {
    try {
        res.json(
            await prisma.movimentacaoEstoque.findMany({
                where: { lojaId: req.lojaId },
                include: { insumo: true },
                orderBy: { createdAt: "desc" },
                take: 100,
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/estoque/manual", async (req, res) => {
    try {
        const { insumoId, type, quantity, reason } = req.body;
        const qtd = Number(quantity);
        const insumo = await prisma.insumo.update({
            where: { id: insumoId },
            data: {
                stock: type === "IN" ? { increment: qtd } : { decrement: qtd },
            },
        });
        await prisma.movimentacaoEstoque.create({
            data: {
                lojaId: req.lojaId,
                insumoId,
                type,
                quantity: qtd,
                reason: reason || "Ajuste Manual",
            },
        });
        res.json({ success: true, insumo });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/estoque/xml/preview", upload.single("xml"), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: "Arquivo inválido." });
        const xmlString = req.file.buffer.toString("utf-8");
        const parser = new xml2js.Parser({
            explicitArray: false,
            ignoreAttrs: true,
            tagNameProcessors: [xml2js.processors.stripPrefix],
        });
        const result = await parser.parseStringPromise(xmlString);
        let dets =
            result.nfeProc?.NFe?.infNFe?.det ||
            result.NFe?.infNFe?.det ||
            result.infNFe?.det;
        if (!dets) return res.status(400).json({ error: "Sem itens." });
        if (!Array.isArray(dets)) dets = [dets];
        const chaveNfe =
            result.nfeProc?.protNFe?.infProt?.chNFe ||
            result.NFe?.infNFe?.Id ||
            "Sem Chave";
        const items = dets.map((item, index) => {
            const prod = item.prod;
            const qCom = parseFloat(prod.qCom || 1);
            const vProd = parseFloat(prod.vProd || 0);
            return {
                id: `xml-${index}`,
                name: prod.xProd || "Produto sem nome",
                quantity: qCom,
                unit: prod.uCom || "UN",
                totalValue: vProd,
                unitCost: qCom > 0 ? vProd / qCom : 0,
            };
        });
        res.json({ success: true, chaveNfe, items });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/estoque/xml/import", async (req, res) => {
    try {
        if (!req.lojaId) return res.status(400).json({ error: 'Loja não identificada.' });

        const { chaveNfe, items } = req.body;

        // 🎯 TRAVA DE SEGURANÇA: Verifica se a NFe já foi importada
        const notaJaImportada = await prisma.movimentacaoEstoque.findFirst({
            where: { lojaId: req.lojaId, xmlRef: chaveNfe }
        });

        if (notaJaImportada) {
            return res.status(400).json({ 
                success: false, 
                error: "❌ Nota Fiscal Recusada: Esta NFe já deu entrada no estoque anteriormente!" 
            });
        }

        // Processa os itens e atualiza o estoque
        for (const item of items) {
            if (item.action === 'IGNORE') continue;

            let insumoId = item.mappedInsumoId;

            // Se for criar um NOVO insumo
            if (item.action === 'NEW') {
                const novoInsumo = await prisma.insumo.create({
                    data: {
                        lojaId: req.lojaId,
                        name: item.name,
                        unit: item.unit,
                        cost: Number(item.unitCost),
                        stock: Number(item.quantity)
                    }
                });
                insumoId = novoInsumo.id;
            } else if (item.action === 'LINK' && insumoId) {
                // Atualiza insumo existente (soma estoque e atualiza custo)
                const insumoAtual = await prisma.insumo.findUnique({ where: { id: insumoId } });
                if (insumoAtual) {
                    await prisma.insumo.update({
                        where: { id: insumoId },
                        data: {
                            stock: Number(insumoAtual.stock) + Number(item.quantity),
                            cost: Number(item.unitCost) // Atualiza para o custo mais recente da nota
                        }
                    });
                }
            }

            // Registra a movimentação atrelando a chave da NFe
            if (insumoId) {
                await prisma.movimentacaoEstoque.create({
                    data: {
                        lojaId: req.lojaId,
                        insumoId: insumoId,
                        type: 'IN',
                        quantity: Number(item.quantity),
                        reason: 'Entrada via XML',
                        xmlRef: chaveNfe
                    }
                });
            }
        }

        res.json({ success: true, message: "✅ Estoque atualizado com sucesso!" });

    } catch (error) {
        console.error("ERRO AO IMPORTAR XML:", error);
        res.status(500).json({ success: false, error: "Erro interno ao processar a importação." });
    }
});

// ==============================================================
// CONSELHEIRO IA - ANÁLISE DE LUCROS E ESTOQUE
// ==============================================================
app.post("/api/ai/analise-lucros", async (req, res) => {
    try {
        if (!req.lojaId) return res.status(400).json({ error: 'Loja não identificada.' });

        const dadosRelatorio = req.body; 
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return res.json({ success: true, analise: "Aviso: A chave GEMINI_API_KEY não foi encontrada no Render." });
        }

        // Busca e filtra os modelos dinamicamente (igual à rota de receitas)
        const modelsRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );
        const modelsData = await modelsRes.json();
        const validModels = modelsData.models
            .filter(
                (m) =>
                    m.supportedGenerationMethods?.includes("generateContent") &&
                    m.name.includes("gemini")
            )
            .sort((a, b) => b.name.localeCompare(a.name));

        const prompt = `Você é um consultor financeiro especialista em restaurantes. Analise os seguintes dados financeiros e de estoque (CMV, Custos, Lucros) e dê 3 conselhos diretos, curtos e práticos para melhorar a margem de lucro. \n\nDados do restaurante: ${JSON.stringify(dadosRelatorio).substring(0, 1500)}`;

        const payload = {
            contents: [
                {
                    parts: [
                        {
                            text: prompt,
                        },
                    ],
                },
            ],
        };

        let textoResposta = null;

        // Loop nos modelos disponíveis para garantir que um vai funcionar
        for (const model of validModels.slice(0, 5)) {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/${model.name}:generateContent?key=${apiKey}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                }
            );
            const data = await response.json();
            
            if (data.error) continue; // Se esse modelo der erro, tenta o próximo
            
            if (data.candidates && data.candidates.length > 0) {
                textoResposta = data.candidates[0].content.parts[0].text;
                break; // Se deu certo, salva a resposta e sai do loop
            }
        }

        if (!textoResposta) {
            return res.json({ success: true, analise: "O Google recusou a conexão para todos os modelos tentados ou a resposta estava vazia." });
        }

        res.json({ success: true, analise: textoResposta });

    } catch (error) {
        console.error("ERRO NO CONSELHEIRO IA:", error);
        res.status(500).json({ error: "Erro interno no servidor da IA." });
    }
});

// ==============================================================
// 7. PDV, TURNOS E CAIXA
// ==============================================================
app.get("/api/pdv/status", async (req, res) => {
    const { employeeId } = req.query;
    try {
        const currentShift = await prisma.shift.findFirst({
            where: { status: "OPEN", lojaId: req.lojaId },
            orderBy: { createdAt: "desc" },
        });
        if (!currentShift)
            return res.json({ hasOpenShift: false, activeRegister: null });
        const activeRegister = await prisma.cashRegister.findFirst({
            where: {
                shiftId: currentShift.id,
                status: "OPEN",
                openedBy: employeeId,
                lojaId: req.lojaId,
            },
            include: { movements: true },
        });
        res.json({
            hasOpenShift: true,
            shiftId: currentShift.id,
            activeRegister,
        });
    } catch (e) {
        res.status(500).json({ error: "Erro PDV" });
    }
});

app.post("/api/pdv/register/open", async (req, res) => {
    const { employeeId, openingBalance } = req.body;
    try {
        let currentShift = await prisma.shift.findFirst({
            where: { status: "OPEN", lojaId: req.lojaId },
        });
        if (!currentShift)
            currentShift = await prisma.shift.create({
                data: {
                    lojaId: req.lojaId,
                    openedBy: employeeId,
                    status: "OPEN",
                },
            });
        const existingRegister = await prisma.cashRegister.findFirst({
            where: {
                shiftId: currentShift.id,
                status: "OPEN",
                openedBy: employeeId,
                lojaId: req.lojaId,
            },
        });
        if (existingRegister)
            return res.status(400).json({ error: "Caixa aberto." });
        const register = await prisma.cashRegister.create({
            data: {
                lojaId: req.lojaId,
                shiftId: currentShift.id,
                openedBy: employeeId,
                status: "OPEN",
                openingBalance: Number(openingBalance) || 0,
            },
        });
        res.status(201).json({
            success: true,
            register,
            shiftId: currentShift.id,
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/pdv/register/close", async (req, res) => {
    const { registerId, closingBalance, closingDetails } = req.body;
    try {
        const register = await prisma.cashRegister.update({
            where: { id: registerId },
            data: {
                status: "CLOSED",
                closedAt: new Date(),
                closingBalance: Number(closingBalance),
                closingDetails: closingDetails
                    ? JSON.stringify(closingDetails)
                    : null,
            },
            include: {
                movements: true,
                orders: {
                    where: { status: { notIn: ["CANCELED", "PENDING"] } },
                },
            },
        });
        res.json({ success: true, register });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/pdv/movement", async (req, res) => {
    const { registerId, type, amount, reason, managerAuth } = req.body;
    try {
        const manager = await prisma.employee.findFirst({
            where: {
                lojaId: req.lojaId,
                OR: [{ email: managerAuth.email }, { cpf: managerAuth.email }],
            },
            include: { profile: true },
        });
        if (
            !manager ||
            !(await bcrypt.compare(managerAuth.password, manager.password))
        )
            return res.status(401).json({ error: "Inválido." });
        res.json({
            success: true,
            movement: await prisma.cashMovement.create({
                data: {
                    lojaId: req.lojaId,
                    registerId,
                    type,
                    amount: Number(amount),
                    reason,
                    authorizedBy: manager.id,
                },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/pdv/shifts", async (req, res) => {
    const { dataInicio, dataFim } = req.query;
    try {
        let filtro = { lojaId: req.lojaId };
        if (dataInicio || dataFim) {
            filtro.openedAt = {};
            if (dataInicio) filtro.openedAt.gte = new Date(dataInicio);
            if (dataFim) filtro.openedAt.lte = new Date(dataFim);
        }
        res.json(
            await prisma.shift.findMany({
                where: filtro,
                include: {
                    registers: { include: { movements: true } },
                    orders: {
                        where: { status: { notIn: ["CANCELED", "PENDING"] } },
                    },
                },
                orderBy: { openedAt: "desc" },
                take: dataInicio || dataFim ? undefined : 30,
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/pdv/shifts/close", async (req, res) => {
    const { shiftId, managerAuth } = req.body;
    try {
        const manager = await prisma.employee.findFirst({
            where: {
                lojaId: req.lojaId,
                OR: [{ email: managerAuth.email }, { cpf: managerAuth.email }],
            },
            include: { profile: true },
        });
        if (
            !manager ||
            !(await bcrypt.compare(managerAuth.password, manager.password))
        )
            return res.status(401).json({ error: "Inválidas." });
        const openRegisters = await prisma.cashRegister.count({
            where: { shiftId, status: "OPEN", lojaId: req.lojaId },
        });
        if (openRegisters > 0)
            return res.status(400).json({ error: "Feche os caixas." });
        const openTabs = await prisma.restaurantTab.count({
            where: { shiftId, status: "OPEN", lojaId: req.lojaId },
        });
        if (openTabs > 0)
            return res.status(400).json({ error: `Existem comandas abertas!` });
        res.json({
            success: true,
            shift: await prisma.shift.update({
                where: { id: shiftId },
                data: {
                    status: "CLOSED",
                    closedAt: new Date(),
                    closedBy: manager.id,
                },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/pdv/shifts/open", async (req, res) => {
    const { managerAuth } = req.body;
    try {
        const manager = await prisma.employee.findFirst({
            where: {
                lojaId: req.lojaId,
                OR: [{ email: managerAuth.email }, { cpf: managerAuth.email }],
            },
            include: { profile: true },
        });
        if (
            !manager ||
            !(await bcrypt.compare(managerAuth.password, manager.password))
        )
            return res.status(401).json({ error: "Inválido." });
        const activeShift = await prisma.shift.findFirst({
            where: { status: "OPEN", lojaId: req.lojaId },
        });
        if (activeShift)
            return res.status(400).json({ error: "Turno em andamento." });
        res.status(201).json({
            success: true,
            shift: await prisma.shift.create({
                data: {
                    lojaId: req.lojaId,
                    openedBy: manager.id,
                    status: "OPEN",
                },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

// ==============================================================
// 8. SALÃO E MESAS
// ==============================================================

app.get("/api/salao/tabs", async (req, res) => {
    try {
        res.json(
            await prisma.restaurantTab.findMany({
                where: { status: "OPEN", lojaId: req.lojaId },
                include: { items: true },
                orderBy: { number: "asc" },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/salao/tabs/open", async (req, res) => {
    const {
        number,
        customerName,
        customerCpf,
        customerBirthDate,
        openedBy,
        customerId,
        customerType,
        managerAuth,
    } = req.body;
    try {
        const existing = await prisma.restaurantTab.findFirst({
            where: {
                number: Number(number),
                status: "OPEN",
                lojaId: req.lojaId,
            },
        });
        if (existing)
            return res
                .status(400)
                .json({ error: `Atendimento ${number} já aberto.` });

        if (customerCpf && customerCpf.trim() !== "") {
            const tabWithSameCpf = await prisma.restaurantTab.findFirst({
                where: {
                    customerCpf: customerCpf,
                    status: "OPEN",
                    lojaId: req.lojaId,
                },
            });
            if (tabWithSameCpf) {
                const tipo =
                    tabWithSameCpf.type === "TABLE" ? "Mesa" : "Comanda";
                return res
                    .status(400)
                    .json({
                        error: `Este CPF já está a ser utilizado na ${tipo} ${tabWithSameCpf.number}. Encerre-a primeiro antes de abrir uma nova.`,
                    });
            }
        }

        const currentShift = await prisma.shift.findFirst({
            where: { status: "OPEN", lojaId: req.lojaId },
        });
        if (!currentShift)
            return res
                .status(400)
                .json({ error: "Abra o caixa antes de operar no salão." });

        let finalCustomerId = customerId;
        let debtToTransfer = 0;

        if (customerCpf && !finalCustomerId) {
            let existingUser = await prisma.user.findFirst({
                where: { cpf: customerCpf, lojaId: req.lojaId },
            });
            if (existingUser) {
                finalCustomerId = existingUser.id;
            } else if (customerName) {
                const randomPassword = await bcrypt.hash(
                    "zenixfood" + Math.floor(Math.random() * 10000),
                    10
                );
                const newUser = await prisma.user.create({
                    data: {
                        lojaId: req.lojaId,
                        name: customerName,
                        cpf: customerCpf,
                        birthDate: customerBirthDate
                            ? new Date(customerBirthDate).toISOString()
                            : null,
                        email: `cliente.${Date.now()}@avulso.com`,
                        password: randomPassword,
                        role: "CLIENT",
                        cashback: {
                            create: { balance: 0.0, lojaId: req.lojaId },
                        },
                    },
                });
                finalCustomerId = newUser.id;
            }
        }

        if (
            (customerType === "Cliente" || finalCustomerId) &&
            finalCustomerId
        ) {
            const pending = await prisma.customerAccountMovement.findMany({
                where: {
                    customerId: finalCustomerId,
                    type: "CHARGE",
                    isPaid: false,
                    lojaId: req.lojaId,
                },
            });
            debtToTransfer = pending.reduce(
                (acc, curr) => acc + curr.amount,
                0
            );

            if (debtToTransfer > 0) {
                if (managerAuth && managerAuth.email && managerAuth.password) {
                    const manager = await prisma.employee.findFirst({
                        where: {
                            lojaId: req.lojaId,
                            OR: [
                                { email: managerAuth.email },
                                { cpf: managerAuth.email },
                            ],
                        },
                    });
                    if (
                        !manager ||
                        !(await bcrypt.compare(
                            managerAuth.password,
                            manager.password
                        ))
                    ) {
                        return res
                            .status(401)
                            .json({
                                error: "Credenciais do gerente inválidas.",
                            });
                    }
                } else {
                    return res
                        .status(400)
                        .json({
                            code: "CLIENT_HAS_DEBT",
                            error: `Cliente possui uma dívida de R$ ${debtToTransfer.toFixed(
                                2
                            )}.`,
                            debtAmount: debtToTransfer,
                        });
                }
            }
        }

        const tab = await prisma.restaurantTab.create({
            data: {
                lojaId: req.lojaId,
                number: Number(number),
                type: Number(number) >= 1000 ? "TAB" : "TABLE",
                customerName: customerName || null,
                customerCpf: customerCpf || null,
                openedBy,
                shiftId: currentShift.id,
            },
        });

        if (debtToTransfer > 0) {
            const p = await getDividaProduct(req.lojaId);
            await prisma.tabItem.create({
                data: {
                    lojaId: req.lojaId,
                    tabId: tab.id,
                    productId: p.id,
                    name: "Acerto de Dívida (Puxado)",
                    price: debtToTransfer,
                    quantity: 1,
                    observation: "Dívida transferida para a mesa pelo Gerente",
                    status: "SERVED",
                },
            });
            await prisma.customerAccountMovement.updateMany({
                where: {
                    customerId: finalCustomerId,
                    type: "CHARGE",
                    isPaid: false,
                    lojaId: req.lojaId,
                },
                data: { isPaid: true, paidAt: new Date() },
            });
            await prisma.customerAccountMovement.create({
                data: {
                    lojaId: req.lojaId,
                    customerId: finalCustomerId,
                    type: "PAYMENT",
                    amount: debtToTransfer,
                    description: `Dívida transferida para a Comanda ${tab.number}`,
                    isPaid: true,
                    paidAt: new Date(),
                },
            });
            await prisma.user.update({
                where: { id: finalCustomerId },
                data: { isBlocked: false },
            });
        }
        res.status(201).json({ success: true, tab });
    } catch (e) {
        res.status(500).json({ error: "Erro interno." });
    }
});

app.post("/api/salao/tabs/:tabId/items", async (req, res) => {
    const { tabId } = req.params;
    const { items, managerAuth } = req.body;
    try {
        const tab = await prisma.restaurantTab.findUnique({
            where: { id: tabId },
            include: { items: true },
        });
        if (tab && (tab.customerName || tab.customerCpf)) {
            let orConditions = [];
            if (tab.customerName) orConditions.push({ name: tab.customerName });
            if (tab.customerCpf) orConditions.push({ cpf: tab.customerCpf });
            if (orConditions.length > 0) {
                const employee = await prisma.employee.findFirst({
                    where: { lojaId: req.lojaId, OR: orConditions },
                });
                if (employee) {
                    const newItemsTotal = items.reduce(
                        (acc, i) => acc + Number(i.price) * Number(i.quantity),
                        0
                    );
                    const currentTabTotal = tab.items.reduce(
                        (acc, i) => acc + Number(i.price) * Number(i.quantity),
                        0
                    );
                    const grossTotal = currentTabTotal + newItemsTotal;
                    const netTotal =
                        grossTotal -
                        grossTotal * ((employee.discountPercent || 0) / 100);
                    const ruleCheck = await checkEmployeeAccountRules(
                        employee.id,
                        netTotal,
                        managerAuth,
                        req.lojaId
                    );
                    if (!ruleCheck.success)
                        return res.status(400).json(ruleCheck);
                }
            }
        }
        let createdItems = [];
        for (let item of items) {
            createdItems.push(
                await prisma.tabItem.create({
                    data: {
                        lojaId: req.lojaId,
                        tabId,
                        productId: item.productId,
                        name: item.name,
                        price: Number(item.price),
                        quantity: Number(item.quantity),
                        observation: item.observation || null,
                        seatLabel: item.seatLabel || null,
                        status: "PREPARING",
                    },
                })
            );
        }
        res.json({ success: true, items: createdItems });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/salao/items/:itemId/status", async (req, res) => {
    try {
        res.json({
            success: true,
            item: await prisma.tabItem.update({
                where: { id: req.params.itemId },
                data: { status: req.body.status },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.delete("/api/salao/items/:itemId", async (req, res) => {
    try {
        await prisma.tabItem.delete({ where: { id: req.params.itemId } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/salao/items/transfer", async (req, res) => {
    const { itemId, targetTabId } = req.body;
    try {
        res.json({
            success: true,
            item: await prisma.tabItem.update({
                where: { id: itemId },
                data: { tabId: targetTabId },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/salao/tabs/number/:number", async (req, res) => {
    try {
        const tab = await prisma.restaurantTab.findFirst({
            where: {
                number: Number(req.params.number),
                status: "OPEN",
                lojaId: req.lojaId,
            },
            include: { items: true },
        });
        if (!tab) return res.status(404).json({ error: "Não encontrado." });
        res.json(tab);
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/salao/tabs/:tabId/link", async (req, res) => {
    try {
        res.json({
            success: true,
            tab: await prisma.restaurantTab.update({
                where: { id: req.params.tabId },
                data: {
                    linkedTable: req.body.linkedTable
                        ? Number(req.body.linkedTable)
                        : null,
                },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/salao/tabs/merge", async (req, res) => {
    const { sourceTabId, targetTabId } = req.body;
    try {
        const sourceTab = await prisma.restaurantTab.findUnique({
            where: { id: sourceTabId },
            include: { items: true },
        });
        const targetTab = await prisma.restaurantTab.findUnique({
            where: { id: targetTabId },
        });
        if (sourceTab.items.length > 0) {
            await prisma.tabItem.updateMany({
                where: { tabId: sourceTabId },
                data: {
                    tabId: targetTabId,
                    seatLabel: `Veio da Comanda ${sourceTab.number}`,
                },
            });
        }
        let mergedName = targetTab.customerName;
        if (sourceTab.customerName) {
            mergedName = targetTab.customerName
                ? `${targetTab.customerName} e ${sourceTab.customerName}`
                : sourceTab.customerName;
        }
        await prisma.$transaction([
            prisma.restaurantTab.update({
                where: { id: targetTabId },
                data: { customerName: mergedName },
            }),
            prisma.restaurantTab.update({
                where: { id: sourceTabId },
                data: { status: "CLOSED" },
            }),
        ]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/salao/tabs/:tabId/cancel", async (req, res) => {
    try {
        await prisma.tabItem.deleteMany({ where: { tabId: req.params.tabId } });
        res.json({
            success: true,
            tab: await prisma.restaurantTab.update({
                where: { id: req.params.tabId },
                data: { status: "CLOSED" },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/salao/tabs/:tabId/close", async (req, res) => {
    const { tabId } = req.params;
    const {
        paymentMethod,
        registerId,
        shiftId,
        seatFilter,
        employeeBuyerId,
        clientId,
        managerAuth,
    } = req.body;
    try {
        const tab = await prisma.restaurantTab.findUnique({
            where: { id: tabId },
            include: { items: true },
        });
        let salaoUser = await prisma.user.findFirst({
            where: { email: "lancamento@zenixfood.com", lojaId: req.lojaId },
        });
        if (!salaoUser) {
            salaoUser = await prisma.user.create({
                data: {
                    lojaId: req.lojaId,
                    name: "App de Lançamento",
                    email: "lancamento@zenixfood.com",
                    password: await bcrypt.hash("lancamentosenha", 10),
                    role: "CLIENT",
                    cashback: { create: { balance: 0.0, lojaId: req.lojaId } },
                },
            });
        }

        const itemsToPay = seatFilter
            ? tab.items.filter((i) => i.seatLabel === seatFilter)
            : tab.items;
        const hasUnservedItems = itemsToPay.some((i) => i.status !== "SERVED");
        if (hasUnservedItems) {
            return res
                .status(400)
                .json({
                    error:
                        "Existem itens na comanda que ainda estão na Cozinha/Bar ou aguardando o Garçom retirar. Marque todos os itens como 'Entregue 🏃' antes de fechar a conta.",
                });
        }

        let totalToPay = itemsToPay.reduce(
            (acc, curr) => acc + curr.price * curr.quantity,
            0
        );

        if (paymentMethod === "EMPLOYEE_ACCOUNT") {
            if (!employeeBuyerId)
                return res
                    .status(400)
                    .json({ error: "Selecione o funcionário no PDV!" });
            const empData = await prisma.employee.findUnique({
                where: { id: employeeBuyerId },
            });
            if (empData && empData.discountPercent > 0)
                totalToPay =
                    totalToPay - totalToPay * (empData.discountPercent / 100);
            const ruleCheck = await checkEmployeeAccountRules(
                employeeBuyerId,
                totalToPay,
                managerAuth,
                req.lojaId
            );
            if (!ruleCheck.success) return res.status(400).json(ruleCheck);
        }

        if (paymentMethod === "CUSTOMER_ACCOUNT") {
            if (!clientId)
                return res
                    .status(400)
                    .json({
                        error:
                            "Selecione o cliente na busca para lançar fiado!",
                    });
            const checkUser = await prisma.user.findUnique({
                where: { id: clientId },
            });
            if (checkUser.isBlocked)
                return res
                    .status(400)
                    .json({ error: "Cliente bloqueado por pendências." });
        }

        const order = await prisma.order.create({
            data: {
                lojaId: req.lojaId,
                clientId: clientId || salaoUser.id,
                address: `Consumo Mesa/Comanda ${tab.number}`,
                paymentMethod,
                total: totalToPay,
                deliveryFee: 0,
                cashbackUsed: 0,
                status: "DELIVERED",
                origin: "SALAO",
                waiter: tab.openedBy,
                registerId: registerId || null,
                shiftId: shiftId || null,
                items: {
                    create: itemsToPay.map((i) => ({
                        lojaId: req.lojaId,
                        productId: i.productId,
                        quantity: i.quantity,
                        price: i.price,
                    })),
                },
            },
        });

        if (paymentMethod === "EMPLOYEE_ACCOUNT") {
            await prisma.employeeAccountMovement.create({
                data: {
                    lojaId: req.lojaId,
                    employeeId: employeeBuyerId,
                    type: "CHARGE",
                    amount: totalToPay,
                    description: `Consumo Mesa/Comanda ${tab.number} (Ped. #${order.shortId})`,
                    isPaid: false,
                },
            });
        }
        if (paymentMethod === "CUSTOMER_ACCOUNT") {
            await prisma.customerAccountMovement.create({
                data: {
                    lojaId: req.lojaId,
                    customerId: clientId,
                    type: "CHARGE",
                    amount: totalToPay,
                    description: `Consumo Mesa/Comanda ${tab.number} (Ped. #${order.shortId})`,
                    isPaid: false,
                },
            });
            await prisma.user.update({
                where: { id: clientId },
                data: { isBlocked: true },
            });
        }

        await prisma.tabItem.deleteMany({
            where: { id: { in: itemsToPay.map((i) => i.id) } },
        });
        const remainingItems = await prisma.tabItem.count({ where: { tabId } });
        if (remainingItems === 0)
            await prisma.restaurantTab.update({
                where: { id: tabId },
                data: { status: "CLOSED" },
            });

        res.json({ success: true, order, totalPaid: totalToPay });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

// ==============================================================
// 9. KDS
// ==============================================================
app.get("/api/kds", async (req, res) => {
    try {
        const activeShift = await prisma.shift.findFirst({
            where: { status: "OPEN", lojaId: req.lojaId },
            orderBy: { createdAt: "desc" },
        });
        const shiftId = activeShift ? activeShift.id : "none";

        const appOrders = await prisma.order.findMany({
            where: {
                lojaId: req.lojaId,
                origin: "APP",
                OR: [
                    {
                        status: {
                            in: ["PENDING", "PREPARING", "READY", "IN_TRANSIT"],
                        },
                    },
                    { status: "DELIVERED", shiftId: shiftId },
                ],
            },
            include: {
                client: true,
                items: {
                    include: { product: { include: { category: true } } },
                },
            },
            orderBy: { createdAt: "asc" },
        });

        const totemOrders = await prisma.order.findMany({
            where: {
                lojaId: req.lojaId,
                origin: "TOTEM",
                OR: [
                    { status: { in: ["PREPARING", "READY"] } },
                    { status: "DELIVERED", shiftId: shiftId },
                ],
            },
            include: {
                client: true,
                items: {
                    include: { product: { include: { category: true } } },
                },
            },
            orderBy: { createdAt: "asc" },
        });

        const salaoItems = await prisma.tabItem.findMany({
            where: {
                lojaId: req.lojaId,
                tab: { status: "OPEN" },
                OR: [
                    { status: { in: ["PENDING", "PREPARING", "READY"] } },
                    { status: "SERVED", tab: { shiftId: shiftId } },
                ],
            },
            include: { tab: true, product: { include: { category: true } } },
            orderBy: { createdAt: "asc" },
        });

        res.json({ success: true, appOrders, totemOrders, salaoItems });
    } catch (e) {
        res.status(500).json({
            error: "Erro ao buscar dados unificados do KDS.",
        });
    }
});

// ==============================================================
// 10. PEDIDOS E CHECKOUT (APP E TOTEM)
// ==============================================================
app.post("/api/orders", async (req, res) => {
    const {
        clientId,
        employeeBuyerId,
        items,
        address,
        paymentMethod,
        total,
        useCashback,
        mpData,
        couponCode,
        origin,
        shiftId,
        registerId,
        pdvDiscount,
        waiter,
        managerAuth,
    } = req.body;
    
    let finalDiscount = Number(pdvDiscount) || 0;
    let finalTotalCart = Number(total);
    let finalOrigin = origin || "APP";
    if (clientId === "TOTEM_MODE") finalOrigin = "TOTEM";

    if (paymentMethod === "EMPLOYEE_ACCOUNT") {
        if (!employeeBuyerId)
            return res
                .status(400)
                .json({ error: "Selecione qual funcionário está consumindo." });
        const empData = await prisma.employee.findUnique({
            where: { id: employeeBuyerId },
        });
        if (empData && empData.discountPercent > 0)
            finalDiscount = finalTotalCart * (empData.discountPercent / 100);
        const amountToCharge = finalTotalCart - finalDiscount;
        const ruleCheck = await checkEmployeeAccountRules(
            employeeBuyerId,
            amountToCharge,
            managerAuth,
            req.lojaId
        );
        if (!ruleCheck.success) return res.status(400).json(ruleCheck);
    }

    if (paymentMethod === "CUSTOMER_ACCOUNT") {
        if (!clientId || clientId === "TOTEM_MODE")
            return res
                .status(400)
                .json({ error: "Selecione um cliente para vender fiado." });
        const checkUser = await prisma.user.findUnique({
            where: { id: clientId },
        });
        if (checkUser?.isBlocked)
            return res
                .status(400)
                .json({
                    error: "O cliente está bloqueado por falta de pagamento.",
                });
    }

    let finalClientId = clientId;
    if (!clientId || clientId === "TOTEM_MODE") {
        let totemUser = await prisma.user.findFirst({
            where: { email: "totem@zenixfood.com", lojaId: req.lojaId },
        });
        if (!totemUser) {
            const randomPassword = await bcrypt.hash("totem", 10);
            totemUser = await prisma.user.create({
                data: {
                    lojaId: req.lojaId,
                    name: "Totem Autoatendimento",
                    email: "totem@zenixfood.com",
                    password: randomPassword,
                    role: "CLIENT",
                    cashback: { create: { balance: 0.0, lojaId: req.lojaId } },
                },
            });
        }
        finalClientId = totemUser.id;
    }

    const hasScheduled = items.some(
        (item) =>
            item.name?.toLowerCase().includes("agendado") || item.isScheduled
    );
    const hasNormal = items.some(
        (item) =>
            !item.name?.toLowerCase().includes("agendado") && !item.isScheduled
    );

    const storeIsOpen = await checkStoreStatus(req.lojaId);
    if (
        !storeIsOpen &&
        hasNormal &&
        clientId !== "TOTEM_MODE" &&
        finalOrigin !== "PDV"
    ) {
        return res
            .status(400)
            .json({ error: "A loja está fechada no momento." });
    }

    const settings = await getSettings(req.lojaId);
    const deliveryFeeActual =
        clientId === "TOTEM_MODE" || finalOrigin === "PDV"
            ? 0
            : Number(settings.deliveryFee);

    try {
        const userWallet = await prisma.cashbackWallet.findUnique({
            where: { userId: finalClientId },
        });
        let currentShiftId = shiftId;
        if (!currentShiftId) {
            let activeShift = await prisma.shift.findFirst({
                where: { status: "OPEN", lojaId: req.lojaId },
            });
            if (!activeShift)
                activeShift = await prisma.shift.create({
                    data: {
                        lojaId: req.lojaId,
                        openedBy: "SISTEMA",
                        status: "OPEN",
                    },
                });
            currentShiftId = activeShift.id;
        }

        let couponDiscount = 0;
        let appliedCoupon = null;
        let coupons = await getCoupons(req.lojaId);

        if (couponCode && clientId !== "TOTEM_MODE" && finalOrigin !== "PDV") {
            appliedCoupon = coupons.find(
                (c) => c.code === couponCode.toUpperCase() && c.active
            );
            if (
                appliedCoupon &&
                appliedCoupon.usedBy &&
                appliedCoupon.usedBy.includes(finalClientId)
            )
                return res
                    .status(400)
                    .json({ error: "Você já usou este cupom!" });
            if (
                appliedCoupon &&
                appliedCoupon.maxUses > 0 &&
                appliedCoupon.usedCount >= appliedCoupon.maxUses
            )
                return res.status(400).json({ error: "Cupom esgotado!" });
            if (
                appliedCoupon &&
                finalTotalCart >= appliedCoupon.minOrderValue
            ) {
                if (appliedCoupon.type === "PERCENTAGE")
                    couponDiscount =
                        finalTotalCart * (appliedCoupon.value / 100);
                else if (appliedCoupon.type === "FIXED")
                    couponDiscount = appliedCoupon.value;
            }
        }

        const baseTotal = finalTotalCart + deliveryFeeActual - couponDiscount;
        let balanceToDeduct = 0;
        if (
            useCashback &&
            userWallet &&
            Number(userWallet.balance) > 0 &&
            clientId !== "TOTEM_MODE" &&
            finalOrigin !== "PDV"
        ) {
            const cbDiscount = Math.min(
                Number(userWallet.balance),
                baseTotal - finalDiscount
            );
            finalDiscount += cbDiscount;
            balanceToDeduct = cbDiscount;
        }

        const finalTotal = baseTotal - finalDiscount;
        let initialStatus =
            paymentMethod === "PIX_ONLINE" ||
            paymentMethod === "CREDIT_CARD_ONLINE"
                ? "PENDING"
                : "PREPARING";
        if (finalOrigin === "PDV") initialStatus = "PREPARING";

        let finalAddress = address;
        if (appliedCoupon) {
            finalAddress += ` | CUPOM APLICADO: ${
                appliedCoupon.code
            } (-R$ ${couponDiscount.toFixed(2)})`;
            appliedCoupon.usedCount = (appliedCoupon.usedCount || 0) + 1;
            if (!appliedCoupon.usedBy) appliedCoupon.usedBy = [];
            appliedCoupon.usedBy.push(finalClientId);
            if (
                appliedCoupon.maxUses > 0 &&
                appliedCoupon.usedCount >= appliedCoupon.maxUses
            )
                appliedCoupon.active = false;
            await prisma.systemConfig
                .update({
                    where: {
                        key_lojaId: { key: "coupons", lojaId: req.lojaId },
                    },
                    data: { data: JSON.stringify(coupons) },
                })
                .catch(() => {});
        }

        const normalItems = items.filter(
            (i) => !i.name?.toLowerCase().includes("agendado") && !i.isScheduled
        );
        const scheduledItems = items.filter(
            (i) => i.name?.toLowerCase().includes("agendado") || i.isScheduled
        );

        let txOps = [];

        // 🎯 MAPPER DINÂMICO SEGURO (Evita o erro de Nulo no Prisma e aceita customizações)
        const mapItemForDB = (item) => {
            const dbItem = {
                lojaId: req.lojaId,
                productId: item.productId || item.id, // Fallback se o cart usar "id" em vez de "productId"
                quantity: item.quantity || 1,
                price: Number(item.price) || 0,
            };

            // Anexa as propriedades EXTRAS APENAS se elas existirem no carrinho do cliente
            if (item.name) dbItem.name = item.name;
            if (item.observation) dbItem.observation = item.observation;
            
            // Busca sabores em "flavors" ou "sabores" (Front-ends diferentes podem usar nomes diferentes)
            const flavorsData = item.flavors || item.sabores;
            if (flavorsData) {
                dbItem.flavors = typeof flavorsData === 'string' ? flavorsData : JSON.stringify(flavorsData);
            }

            if (item.comboItems) {
                dbItem.comboItems = typeof item.comboItems === 'string' ? item.comboItems : JSON.stringify(item.comboItems);
            }

            return dbItem;
        };

        if (normalItems.length > 0 && scheduledItems.length > 0) {
            const scheduledTotal = scheduledItems.reduce(
                (acc, i) => acc + Number(i.price) * i.quantity,
                0
            );
            const normalTotal = finalTotal - scheduledTotal;
            let normalAddress = finalAddress
                .replace(/\[AGENDADO DOM:.*?\]\s*/i, "")
                .replace(/\[ENCOMENDA DOMINGO\]\s*/i, "")
                .trim();
            normalAddress = normalAddress.replace(/\|\s*OBS:\s*$/, "").trim();

            txOps.push(
                prisma.order.create({
                    data: {
                        lojaId: req.lojaId,
                        clientId: finalClientId,
                        address: normalAddress,
                        paymentMethod,
                        total: normalTotal,
                        deliveryFee: deliveryFeeActual,
                        cashbackUsed: finalDiscount,
                        status: initialStatus,
                        origin: finalOrigin,
                        waiter: waiter || null,
                        shiftId: currentShiftId,
                        registerId: registerId || null,
                        items: {
                            create: normalItems.map(mapItemForDB),
                        },
                    },
                    include: { client: true },
                })
            );
            txOps.push(
                prisma.order.create({
                    data: {
                        lojaId: req.lojaId,
                        clientId: finalClientId,
                        address: finalAddress,
                        paymentMethod,
                        total: scheduledTotal,
                        deliveryFee: 0,
                        cashbackUsed: 0,
                        status: initialStatus,
                        origin: finalOrigin,
                        waiter: waiter || null,
                        shiftId: currentShiftId,
                        registerId: registerId || null,
                        items: {
                            create: scheduledItems.map(mapItemForDB),
                        },
                    },
                    include: { client: true },
                })
            );
        } else {
            txOps.push(
                prisma.order.create({
                    data: {
                        lojaId: req.lojaId,
                        clientId: finalClientId,
                        address: finalAddress,
                        paymentMethod,
                        total: finalTotal,
                        deliveryFee: deliveryFeeActual,
                        cashbackUsed: finalDiscount,
                        status: initialStatus,
                        origin: finalOrigin,
                        waiter: waiter || null,
                        shiftId: currentShiftId,
                        registerId: registerId || null,
                        items: {
                            create: items.map(mapItemForDB),
                        },
                    },
                    include: { client: true },
                })
            );
        }

        if (balanceToDeduct > 0)
            txOps.push(
                prisma.cashbackWallet.update({
                    where: { userId: finalClientId },
                    data: { balance: { decrement: balanceToDeduct } },
                })
            );

        const txResults = await prisma.$transaction(txOps);
        const createdOrders = txResults.filter((r) => r.shortId);
        const mainOrder = createdOrders[0];

        if (paymentMethod === "EMPLOYEE_ACCOUNT" && employeeBuyerId) {
            await prisma.employeeAccountMovement.create({
                data: {
                    lojaId: req.lojaId,
                    employeeId: employeeBuyerId,
                    type: "CHARGE",
                    amount: finalTotal,
                    description: `Consumo PDV (Pedido #${mainOrder.shortId})`,
                    isPaid: false,
                },
            });
        }
        if (paymentMethod === "CUSTOMER_ACCOUNT") {
            await prisma.customerAccountMovement.create({
                data: {
                    lojaId: req.lojaId,
                    customerId: finalClientId,
                    type: "CHARGE",
                    amount: finalTotal,
                    description: `Consumo PDV (Pedido #${mainOrder.shortId})`,
                    isPaid: false,
                },
            });
            await prisma.user.update({
                where: { id: finalClientId },
                data: { isBlocked: true },
            });
        }

        const updatedWallet = txResults.find((r) => r.balance !== undefined);
        const newBalance = updatedWallet
            ? updatedWallet.balance
            : userWallet
            ? userWallet.balance
            : 0;
        const externalRef = createdOrders.map((o) => o.id).join("|");

        if (paymentMethod === "PIX_ONLINE" && finalOrigin !== "PDV") {
            const payment = new Payment(clientMP);
            const paymentData = await payment.create({
                body: {
                    transaction_amount: Number(finalTotal.toFixed(2)),
                    description: `Pedido ZenixFood`,
                    payment_method_id: "pix",
                    payer: {
                        email: mainOrder.client.email || "cliente@email.com",
                        first_name:
                            mainOrder.client.name.split(" ")[0] || "Cliente",
                    },
                    external_reference: externalRef,
                    notification_url:
                        "https://zenixfood-backend.onrender.com/api/webhook",
                },
            });
            return res
                .status(201)
                .json({
                    success: true,
                    order: mainOrder,
                    pix: {
                        qr_code:
                            paymentData.point_of_interaction.transaction_data
                                .qr_code,
                        qr_code_base64:
                            paymentData.point_of_interaction.transaction_data
                                .qr_code_base64,
                        orderId: mainOrder.id,
                    },
                    newBalance,
                });
        }

        if (
            paymentMethod === "CREDIT_CARD_ONLINE" &&
            mpData &&
            clientId !== "TOTEM_MODE" &&
            finalOrigin !== "PDV"
        ) {
            const payment = new Payment(clientMP);
            const paymentData = await payment.create({
                body: {
                    transaction_amount: Number(finalTotal.toFixed(2)),
                    token: mpData.token,
                    description: `Pedido ZenixFood`,
                    installments: Number(mpData.installments),
                    payment_method_id: mpData.payment_method_id,
                    issuer_id: mpData.issuer_id,
                    payer: {
                        email: mpData.payer.email || mainOrder.client.email,
                        identification: mpData.payer.identification,
                    },
                    external_reference: externalRef,
                    notification_url:
                        "https://zenixfood-backend.onrender.com/api/webhook",
                },
            });
            if (
                paymentData.status === "approved" ||
                paymentData.status === "in_process"
            ) {
                await prisma.order.updateMany({
                    where: { id: { in: createdOrders.map((o) => o.id) } },
                    data: { status: "PREPARING" },
                });
                return res
                    .status(201)
                    .json({ success: true, order: mainOrder, newBalance });
            } else {
                await prisma.order.updateMany({
                    where: { id: { in: createdOrders.map((o) => o.id) } },
                    data: { status: "CANCELED" },
                });
                return res
                    .status(400)
                    .json({
                        error: "Pagamento recusado.",
                        details: paymentData.status_detail,
                    });
            }
        }

        res.status(201).json({
            success: true,
            order: mainOrder,
            discountApplied: finalDiscount,
            newBalance,
        });
    } catch (error) {
        // 🔥 Console.error adicionado para registrar o motivo exato no log do Render
        console.error("ERRO GRAVE NO CHECKOUT:", error);
        res.status(500).json({ error: "Erro ao processar o pedido", details: error.message });
    }
});

app.post("/api/orders/:id/retry-pix", async (req, res) => {
    try {
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
            include: { client: true },
        });
        if (!order || order.status !== "PENDING")
            return res.status(400).json({ error: "Pedido inválido." });

        const payment = new Payment(clientMP);
        const externalRef = `${order.id}|RETRY`;

        const paymentData = await payment.create({
            body: {
                transaction_amount: Number(order.total),
                description: `Pedido ZenixFood`,
                payment_method_id: "pix",
                payer: {
                    email: order.client?.email || "cliente@email.com",
                    first_name: order.client?.name?.split(" ")[0] || "Cliente",
                },
                external_reference: externalRef,
                notification_url:
                    "https://zenixfood-backend.onrender.com/api/webhook",
            },
        });

        res.json({
            success: true,
            pix: {
                qr_code:
                    paymentData.point_of_interaction.transaction_data.qr_code,
                qr_code_base64:
                    paymentData.point_of_interaction.transaction_data
                        .qr_code_base64,
                orderId: order.id,
            },
        });
    } catch (error) {
        res.status(500).json({ error: "Erro ao gerar novo PIX." });
    }
});

app.post("/api/webhook", async (req, res) => {
    const { type, data } = req.body;
    res.status(200).send("OK");
    if (type === "payment") {
        try {
            const response = await fetch(
                `https://api.mercadopago.com/v1/payments/${data.id}`,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                    },
                }
            );
            const paymentInfo = await response.json();
            if (paymentInfo.status === "approved") {
                const refs = paymentInfo.external_reference.split("|");
                for (const ref of refs) {
                    const currentOrder = await prisma.order.findUnique({
                        where: { id: ref },
                    });
                    if (currentOrder && currentOrder.status === "PENDING") {
                        await prisma.order.update({
                            where: { id: currentOrder.id },
                            data: { status: "PREPARING" },
                        });
                    }
                }
            }
        } catch (error) {}
    }
});

// Outras listagens
app.get("/api/orders", async (req, res) => {
    try {
        res.json(
            await prisma.order.findMany({
                where: { lojaId: req.lojaId },
                include: {
                    client: true,
                    items: { include: { product: true } },
                    deliveryPerson: { select: { name: true } },
                },
                orderBy: { createdAt: "desc" },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/orders/client/:clientId", async (req, res) => {
    try {
        res.json(
            await prisma.order.findMany({
                where: { lojaId: req.lojaId, clientId: req.params.clientId },
                include: { items: { include: { product: true } } },
                orderBy: { createdAt: "desc" },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/orders/:id/status", async (req, res) => {
    try {
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
            select: { status: true },
        });
        res.json(order);
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/orders/:id/status", async (req, res) => {
    try {
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
            include: { client: { include: { cashback: true } } },
        });
        if (!order) return res.status(404).json({ error: "Erro" });
        const [updatedOrder, updatedWallet] = await prisma.$transaction([
            prisma.order.update({
                where: { id: order.id },
                data: { status: req.body.status },
            }),
        ]);
        res.json({
            success: true,
            newBalance: updatedWallet ? updatedWallet.balance : 0,
        });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/orders/:id/cancel", async (req, res) => {
    try {
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
        });
        if (!order) return res.status(404).json({ error: "Erro" });
        if (order.status !== "PENDING")
            return res.status(400).json({ error: "Apenas pendentes" });

        if (
            order.cashbackUsed > 0 &&
            order.clientId &&
            order.clientId !== "TOTEM_MODE"
        ) {
            try {
                await prisma.cashbackWallet.update({
                    where: { userId: order.clientId },
                    data: { balance: { increment: order.cashbackUsed } },
                });
            } catch (e) {}
        }
        const updatedOrder = await prisma.order.update({
            where: { id: req.params.id },
            data: { status: "CANCELED" },
        });
        res.json({ success: true, order: updatedOrder });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/rh/delivery-persons", async (req, res) => {
    try {
        res.json(
            await prisma.employee.findMany({
                where: { lojaId: req.lojaId, isActive: true },
                select: { id: true, name: true, role: true },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.put("/api/orders/dispatch", async (req, res) => {
    try {
        await prisma.order.updateMany({
            where: { id: { in: req.body.orderIds }, lojaId: req.lojaId },
            data: {
                status: "IN_TRANSIT",
                deliveryPersonId: req.body.deliveryPersonId,
            },
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.get("/api/delivery/my-orders/:employeeId", async (req, res) => {
    try {
        res.json(
            await prisma.order.findMany({
                where: {
                    lojaId: req.lojaId,
                    deliveryPersonId: req.params.employeeId,
                    status: "IN_TRANSIT",
                },
                include: {
                    client: true,
                    items: { include: { product: true } },
                },
                orderBy: { createdAt: "asc" },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/delivery/confirm", async (req, res) => {
    try {
        const order = await prisma.order.findFirst({
            where: {
                lojaId: req.lojaId,
                shortId: Number(req.body.shortId),
                status: "IN_TRANSIT",
            },
            include: { client: true },
        });
        if (!order)
            return res.status(404).json({ error: "Pedido não encontrado." });
        let correctCode = "0000";
        if (order.client && order.client.phone) {
            const phoneDigits = order.client.phone.replace(/\D/g, "");
            if (phoneDigits.length >= 4) correctCode = phoneDigits.slice(-4);
        }
        if (
            req.body.code !== correctCode &&
            req.body.code !== "0000" &&
            req.body.code !== String(order.shortId).padStart(4, "0")
        ) {
            return res.status(400).json({ error: `Código incorreto!` });
        }
        await prisma.order.update({
            where: { id: order.id },
            data: { status: "DELIVERED" },
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

app.post("/api/admin/orders/:id/fiscal", async (req, res) => {
    try {
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
            include: { client: true, items: { include: { product: true } } },
        });
        if (!order)
            return res.status(404).json({ error: "Pedido não encontrado." });
        if (order.nfceData)
            return res
                .status(200)
                .json({
                    success: true,
                    fiscalData: JSON.parse(order.nfceData),
                    alreadyEmitted: true,
                });

        const isHomologacao = process.env.FOCUS_ENV !== "producao";
        const baseUrl = isHomologacao
            ? "https://homologacao.focusnfe.com.br/v2/nfce"
            : "https://api.focusnfe.com.br/v2/nfce";
        const token = process.env.FOCUS_TOKEN;
        if (!token)
            return res.status(500).json({ error: "Token fiscal ausente." });
        const authHeader =
            "Basic " + Buffer.from(token.trim() + ":").toString("base64");

        const regrasFiscais = await getFiscalData(req.lojaId);
        const configuracoes = await getSettings(req.lojaId);
        const cnpjEmitente = configuracoes.storeCnpj
            ? configuracoes.storeCnpj.replace(/\D/g, "")
            : null;
        if (!cnpjEmitente)
            return res
                .status(400)
                .json({ error: "CNPJ do Emitente não configurado!" });

        const itensSefaz = order.items.map((item, index) => {
            const valorUnitario = parseFloat(item.price).toFixed(2);
            const quantidade = item.quantity;
            const valorTotalItem = (valorUnitario * quantidade).toFixed(2);

            let sizeSuffix = "";
            if (
                item.product.price1kg &&
                Number(item.price) === Number(item.product.price1kg)
            )
                sizeSuffix = " - 1kg";
            else if (
                item.product.price700g &&
                Number(item.price) === Number(item.product.price700g)
            )
                sizeSuffix = " - 700g";
            else if (
                item.product.name.toLowerCase().includes("costela") &&
                item.product.price700g
            )
                sizeSuffix = " - 500g";

            let ncm = item.product.ncm || "21069090";
            let cfop = "5102";
            let icms_cst = "102";
            let pis_cst = "49";
            let cofins_cst = "49";
            let icms_aliq = 0;
            let pis_aliq = 0;
            let cofins_aliq = 0;
            let ibs_cst = "000";
            let ibs_class = "000001";
            let ibs_aliq = 0.1;
            let cbs_aliq = 0.9;

            if (item.product.regraFiscalId) {
                const regraAtiva = regrasFiscais.regras?.find(
                    (r) => r.id === item.product.regraFiscalId
                );
                if (regraAtiva) {
                    const icms = regrasFiscais.icms?.find(
                        (i) => i.id === regraAtiva.icmsId
                    );
                    if (icms) {
                        cfop = icms.cfop || cfop;
                        icms_cst = icms.cst || icms_cst;
                        icms_aliq = parseFloat(icms.aliquota || 0);
                    }
                    const pisCofins = regrasFiscais.pisCofins?.find(
                        (p) => p.id === regraAtiva.pisCofinsId
                    );
                    if (pisCofins) {
                        pis_cst = pisCofins.cstPis || pis_cst;
                        cofins_cst = pisCofins.cstCofins || cofins_cst;
                        pis_aliq = parseFloat(pisCofins.aliqPis || 0);
                        cofins_aliq = parseFloat(pisCofins.aliqCofins || 0);
                    }
                    const ibsCbsRegra = regrasFiscais.ibsCbs?.find(
                        (i) => i.id === regraAtiva.ibsCbsId
                    );
                    if (ibsCbsRegra) {
                        ibs_cst = ibsCbsRegra.cst || ibs_cst;
                        ibs_class = ibsCbsRegra.classificacao || ibs_class;
                        ibs_aliq = parseFloat(ibsCbsRegra.aliqIbsUf || 0);
                        cbs_aliq = parseFloat(ibsCbsRegra.aliqCbs || 0);
                    }
                }
            }

            const vProdNum = parseFloat(valorTotalItem);
            const cbsValor = (vProdNum * (cbs_aliq / 100)).toFixed(2);
            const ibsUfValor = (vProdNum * (ibs_aliq / 100)).toFixed(2);

            const itemSefazPayload = {
                numero_item: index + 1,
                codigo_produto: item.product.id.substring(0, 50),
                descricao: item.product.name + sizeSuffix,
                codigo_ncm: ncm,
                cfop: cfop,
                unidade_comercial: "UN",
                quantidade_comercial: quantidade.toString(),
                valor_unitario_comercial: valorUnitario,
                valor_unitario_tributavel: valorUnitario,
                unidade_tributavel: "UN",
                quantidade_tributavel: quantidade.toString(),
                valor_bruto: valorTotalItem,
                icms_situacao_tributaria: icms_cst,
                icms_origem: "0",
                pis_situacao_tributaria: pis_cst,
                cofins_situacao_tributaria: cofins_cst,
                ibs_cbs_situacao_tributaria: ibs_cst,
                ibs_cbs_classificacao_tributaria: ibs_class,
                ibs_cbs_base_calculo: valorTotalItem,
                cbs_aliquota: cbs_aliq.toString(),
                cbs_valor: cbsValor,
                ibs_uf_aliquota: ibs_aliq.toString(),
                ibs_uf_valor: ibsUfValor,
                ibs_mun_aliquota: "0",
                ibs_mun_valor: "0.00",
                ibs_valor_total: ibsUfValor,
            };

            if (icms_aliq > 0)
                itemSefazPayload.icms_aliquota = icms_aliq.toString();
            if (pis_aliq > 0)
                itemSefazPayload.pis_aliquota_porcentual = pis_aliq.toString();
            if (cofins_aliq > 0)
                itemSefazPayload.cofins_aliquota_porcentual = cofins_aliq.toString();
            return itemSefazPayload;
        });

        let codigoPagamento = "01";
        if (order.paymentMethod.includes("CREDIT")) codigoPagamento = "03";
        if (order.paymentMethod.includes("DEBIT")) codigoPagamento = "04";
        if (order.paymentMethod.includes("PIX")) codigoPagamento = "17";

        const payloadNfce = {
            cnpj_emitente: cnpjEmitente,
            natureza_operacao: "VENDA DE MERCADORIA",
            data_emissao: new Date().toISOString(),
            tipo_documento: "1",
            local_destino: "1",
            finalidade_emissao: "1",
            consumidor_final: "1",
            presenca_comprador: "1",
            modalidade_frete: "9",
            itens: itensSefaz,
            pagamentos: [
                {
                    forma_pagamento: codigoPagamento,
                    valor_pagamento: parseFloat(order.total).toFixed(2),
                },
            ],
            ...(order.client?.cpf && {
                nome_destinatario: order.client.name,
                cpf_destinatario: order.client.cpf.replace(/\D/g, ""),
            }),
        };

        const response = await fetch(`${baseUrl}?ref=${order.shortId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: authHeader,
            },
            body: JSON.stringify(payloadNfce),
        });
        const dadosRetorno = await response.json();

        if (
            response.ok &&
            (dadosRetorno.status === "autorizado" ||
                dadosRetorno.status === "processando")
        ) {
            const dominioFocus = isHomologacao
                ? "https://homologacao.focusnfe.com.br"
                : "https://api.focusnfe.com.br";
            const linkDanfe = dadosRetorno.caminho_danfe
                ? `${dominioFocus}${dadosRetorno.caminho_danfe}`
                : null;
            const fiscalDataObj = {
                chaveAcesso:
                    dadosRetorno.chave_nfe || dadosRetorno.chave_nfe_autorizada,
                protocolo: dadosRetorno.protocolo || "Em processamento...",
                urlQrCode: dadosRetorno.qr_code_url,
                urlDanfe: linkDanfe,
                numero: dadosRetorno.numero,
                items: order.items.map((i) => ({
                    nome: i.product.name,
                    quantidade: i.quantity,
                    preco: parseFloat(i.price).toFixed(2),
                })),
                total: parseFloat(order.total).toFixed(2),
            };
            await prisma.order.update({
                where: { id: order.id },
                data: { nfceData: JSON.stringify(fiscalDataObj) },
            });
            return res
                .status(200)
                .json({ success: true, fiscalData: fiscalDataObj });
        } else {
            return res
                .status(400)
                .json({
                    error: "Falha ao autorizar NFC-e",
                    details: dadosRetorno,
                });
        }
    } catch (error) {
        return res
            .status(500)
            .json({ error: "Erro interno", details: error.message });
    }
});

// Analytics
app.post("/api/analytics/visit", async (req, res) => {
    try {
        const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
        await prisma.accessLog.create({
            data: {
                lojaId: req.lojaId,
                ip: ip ? ip.split(",")[0].trim() : "Desconhecido",
                device: req.body.device || "Desconhecido",
                userId: req.body.userId || null,
            },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.get("/api/admin/analytics", async (req, res) => {
    try {
        res.json({
            success: true,
            visits: await prisma.accessLog.findMany({
                where: { lojaId: req.lojaId },
                orderBy: { createdAt: "desc" },
                take: 300,
                include: { user: { select: { name: true, email: true } } },
            }),
            totalVisits: await prisma.accessLog.count({
                where: { lojaId: req.lojaId },
            }),
        });
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});
app.delete("/api/admin/analytics", async (req, res) => {
    try {
        const { type, startDate, endDate } = req.body;
        if (type === "all") {
            await prisma.accessLog.deleteMany({
                where: { lojaId: req.lojaId },
            });
        } else if (type === "range" && startDate && endDate) {
            await prisma.accessLog.deleteMany({
                where: {
                    lojaId: req.lojaId,
                    createdAt: {
                        gte: new Date(startDate + "T00:00:00.000Z"),
                        lte: new Date(endDate + "T23:59:59.999Z"),
                    },
                },
            });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Financeiro
app.post("/api/financeiro/contas-pagar", async (req, res) => {
    try {
        res.status(201).json({
            success: true,
            conta: await prisma.contaPagar.create({
                data: {
                    lojaId: req.lojaId,
                    descricao: req.body.descricao,
                    valor: Number(req.body.valor),
                    dataVencimento: new Date(req.body.dataVencimento),
                    fornecedor: req.body.fornecedor,
                },
            }),
        });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});
app.get("/api/financeiro/contas-pagar", async (req, res) => {
    try {
        res.json(
            await prisma.contaPagar.findMany({
                where: {
                    lojaId: req.lojaId,
                    ...(req.query.status ? { status: req.query.status } : {}),
                },
                orderBy: { dataVencimento: "asc" },
            })
        );
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});
app.put("/api/financeiro/contas-pagar/:id/pagar", async (req, res) => {
    try {
        const contaPaga = await prisma.contaPagar.update({
            where: { id: req.params.id },
            data: {
                status: "PAGO",
                dataPagamento: new Date(),
                metodoPagamento: req.body.metodoPagamento,
                shiftId: req.body.shiftId || null,
            },
        });
        if (req.body.shiftId && req.body.metodoPagamento === "DINHEIRO") {
            const register = await prisma.cashRegister.findFirst({
                where: { shiftId: req.body.shiftId, status: "OPEN" },
            });
            if (register)
                await prisma.cashMovement.create({
                    data: {
                        lojaId: req.lojaId,
                        registerId: register.id,
                        type: "OUT",
                        amount: contaPaga.valor,
                        reason: `Pagamento de Conta: ${contaPaga.descricao}`,
                        authorizedBy: "SISTEMA",
                    },
                });
        }
        res.json({ success: true, conta: contaPaga });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});
app.get("/api/financeiro/relatorio", async (req, res) => {
    try {
        const start = req.query.dataInicio
            ? new Date(req.query.dataInicio)
            : new Date(new Date().setHours(0, 0, 0, 0));
        const end = req.query.dataFim
            ? new Date(req.query.dataFim)
            : new Date(new Date().setHours(23, 59, 59, 999));
        const pedidos = await prisma.order.findMany({
            where: {
                lojaId: req.lojaId,
                createdAt: { gte: start, lte: end },
                status: "DELIVERED",
            },
        });
        const totalVendas = pedidos.reduce(
            (acc, p) => acc + Number(p.total),
            0
        );
        const vendasPorMetodo = pedidos.reduce((acc, p) => {
            acc[p.paymentMethod] =
                (acc[p.paymentMethod] || 0) + Number(p.total);
            return acc;
        }, {});
        const contasPagas = await prisma.contaPagar.findMany({
            where: {
                lojaId: req.lojaId,
                dataPagamento: { gte: start, lte: end },
                status: "PAGO",
            },
        });
        const totalDespesas = contasPagas.reduce(
            (acc, c) => acc + Number(c.valor),
            0
        );
        const movimentosCaixa = await prisma.cashMovement.findMany({
            where: { lojaId: req.lojaId, createdAt: { gte: start, lte: end } },
        });
        const suprimentos = movimentosCaixa
            .filter((m) => m.type === "IN")
            .reduce((acc, m) => acc + Number(m.amount), 0);
        const sangrias = movimentosCaixa
            .filter((m) => m.type === "OUT")
            .reduce((acc, m) => acc + Number(m.amount), 0);
        res.json({
            success: true,
            periodo: { start, end },
            resumo: {
                totalVendas,
                totalDespesas,
                saldoLiquido: totalVendas - totalDespesas,
                suprimentosCaixa: suprimentos,
                sangriasCaixa: sangrias,
            },
            detalhamento: {
                vendasPorMetodo,
                contasPagas,
                movimentacoesCaixa: movimentosCaixa,
            },
        });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});

// AI Receitas
app.post("/api/ai/receitas/gerar", async (req, res) => {
    const { prompt } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Chave ausente" });
    try {
        const modelsRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );
        const modelsData = await modelsRes.json();
        const validModels = modelsData.models
            .filter(
                (m) =>
                    m.supportedGenerationMethods?.includes("generateContent") &&
                    m.name.includes("gemini")
            )
            .sort((a, b) => b.name.localeCompare(a.name));
        let recipeData = null;
        const payload = {
            contents: [
                {
                    parts: [
                        {
                            text: `Você é um renomado Chef. O usuário pediu: "${prompt}". Retorne APENAS um JSON: {"nome": "string", "ingredientes": ["Pão", "Carne"], "preparo": "string"}. Sem markdown.`,
                        },
                    ],
                },
            ],
        };
        for (const model of validModels.slice(0, 5)) {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/${model.name}:generateContent?key=${apiKey}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                }
            );
            const data = await response.json();
            if (data.error) continue;
            if (data.candidates && data.candidates.length > 0) {
                let cleanJson = data.candidates[0].content.parts[0].text
                    .replace(/```json/gi, "")
                    .replace(/```/g, "")
                    .trim();
                const fb = cleanJson.indexOf("{");
                const lb = cleanJson.lastIndexOf("}");
                if (fb !== -1 && lb !== -1)
                    cleanJson = cleanJson.substring(fb, lb + 1);
                try {
                    recipeData = JSON.parse(cleanJson);
                    break;
                } catch (e) {
                    continue;
                }
            }
        }
        if (!recipeData) return res.status(500).json({ error: `Recusado.` });
        res.json({ success: true, receita: recipeData });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});
app.post("/api/ai/receitas/aprovar", async (req, res) => {
    try {
        const receita = await prisma.receita.create({
            data: {
                lojaId: req.lojaId,
                nome: req.body.nome,
                ingredientes: JSON.stringify(req.body.ingredientes),
                preparo: req.body.preparo,
            },
        });
        const insumosAtuais = await prisma.insumo.findMany({
            where: { lojaId: req.lojaId },
        });
        const nomesAtuais = insumosAtuais.map((i) =>
            i.name.toLowerCase().trim()
        );
        for (const ing of req.body.ingredientes) {
            if (!nomesAtuais.includes(ing.toLowerCase().trim()))
                await prisma.insumo.create({
                    data: {
                        lojaId: req.lojaId,
                        name: ing,
                        unit: "UN",
                        cost: 0,
                        stock: 0,
                    },
                });
        }
        res.json({ success: true, receita });
    } catch (error) {
        res.status(500).json({ error: "Erro" });
    }
});
app.get("/api/ai/receitas", async (req, res) => {
    try {
        res.json(
            await prisma.receita.findMany({
                where: { lojaId: req.lojaId },
                orderBy: { criadoEm: "desc" },
            })
        );
    } catch (e) {
        res.status(500).json({ error: "Erro" });
    }
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () =>
    console.log(`🚀 ZenixFood Server Multi-Tenant rodando na porta ${PORT}`)
);
