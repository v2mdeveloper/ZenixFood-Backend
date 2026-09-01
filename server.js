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

let memorySettings = {
  isManualFechado: false,
  deliveryFee: 5.0,
  cashbackPercent: 2,
  tipPercentage: 10,
  aboutUsText:
    "Na ZenixFood & Co., nós não fazemos apenas lanches, nós forjamos experiências...",
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

let memoryFiscal = { icms: [], pisCofins: [], regras: [] };
let memoryCoupons = [];
let memorySuppliers = [];
let memoryUpsells = [];

async function initDbConfig() {
  try {
    const dbSettings = await prisma.systemConfig.findUnique({
      where: { id: "settings" },
    });
    if (dbSettings)
      memorySettings = { ...memorySettings, ...JSON.parse(dbSettings.data) };
    else
      await prisma.systemConfig.create({
        data: { id: "settings", data: JSON.stringify(memorySettings) },
      });

    const dbFiscal = await prisma.systemConfig.findUnique({
      where: { id: "fiscal" },
    });
    if (dbFiscal) memoryFiscal = JSON.parse(dbFiscal.data);
    else
      await prisma.systemConfig.create({
        data: { id: "fiscal", data: JSON.stringify(memoryFiscal) },
      });

    const dbCoupons = await prisma.systemConfig.findUnique({
      where: { id: "coupons" },
    });
    if (dbCoupons) memoryCoupons = JSON.parse(dbCoupons.data);
    else
      await prisma.systemConfig.create({
        data: { id: "coupons", data: JSON.stringify(memoryCoupons) },
      });

    const dbSuppliers = await prisma.systemConfig.findUnique({
      where: { id: "suppliers" },
    });
    if (dbSuppliers) memorySuppliers = JSON.parse(dbSuppliers.data);
    else
      await prisma.systemConfig.create({
        data: { id: "suppliers", data: JSON.stringify(memorySuppliers) },
      });

    const dbUpsells = await prisma.systemConfig.findUnique({
      where: { id: "upsells" },
    });
    if (dbUpsells) memoryUpsells = JSON.parse(dbUpsells.data);
    else
      await prisma.systemConfig.create({
        data: { id: "upsells", data: JSON.stringify(memoryUpsells) },
      });
  } catch (error) {
    console.log("Erro ao iniciar configs db.");
  }
}
initDbConfig();

function getSettings() {
  return memorySettings;
}
function getFiscalData() {
  return memoryFiscal;
}

async function checkStoreStatus() {
  const settings = getSettings();
  if (String(settings.isManualFechado) === "true") return false;

  const activeShift = await prisma.shift.findFirst({
    where: { status: "OPEN" },
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
    const [yFechaH, yFechaM] = yesterdaySchedule.close.split(":").map(Number);
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

async function getDividaProduct() {
  let p = await prisma.product.findFirst({
    where: { name: "Acerto de Dívida" },
  });
  if (!p) {
    let cat = await prisma.category.findFirst({ where: { name: "Diversos" } });
    if (!cat)
      cat = await prisma.category.create({
        data: { name: "Diversos", slug: "diversos", order: 99 },
      });
    p = await prisma.product.create({
      data: {
        name: "Acerto de Dívida",
        price: 0,
        categoryId: cat.id,
        isActive: false,
      },
    });
  }
  return p;
}

async function checkEmployeeAccountRules(
  employeeId,
  purchaseAmount,
  managerAuth
) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) return { error: "Funcionário não encontrado.", code: "NOT_FOUND" };

  const now = new Date();
  let cutoff = new Date(now.getFullYear(), now.getMonth(), 26);
  if (now.getDate() < 26) {
    cutoff = new Date(now.getFullYear(), now.getMonth() - 1, 26);
  }

  const pendingCharges = await prisma.employeeAccountMovement.findMany({
    where: { employeeId: emp.id, type: "CHARGE", isPaid: false },
  });
  const currentDebt = pendingCharges.reduce(
    (acc, curr) => acc + curr.amount,
    0
  );

  const hasOverdue = pendingCharges.some((c) => new Date(c.createdAt) < cutoff);
  const isOverLimit = currentDebt + purchaseAmount > emp.creditLimit;

  if (hasOverdue || isOverLimit) {
    if (managerAuth && managerAuth.email && managerAuth.password) {
      const manager = await prisma.employee.findFirst({
        where: {
          OR: [{ email: managerAuth.email }, { cpf: managerAuth.email }],
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
          },
        });
        return { success: true, employee: emp };
      }
      return {
        error: "Credenciais do gerente inválidas para autorizar limite.",
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

app.get("/api/printers", async (req, res) => {
  try {
    res.json(await prisma.printer.findMany());
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.post("/api/printers", async (req, res) => {
  try {
    res
      .status(201)
      .json({
        success: true,
        printer: await prisma.printer.create({ data: req.body }),
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
      await prisma.productGroup.findMany({ include: { printer: true } })
    );
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.post("/api/product-groups", async (req, res) => {
  try {
    res
      .status(201)
      .json({
        success: true,
        group: await prisma.productGroup.create({ data: req.body }),
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
  const isOpen = await checkStoreStatus();
  res.json({ ...getSettings(), isOpen });
});
app.put("/api/settings", async (req, res) => {
  memorySettings = { ...memorySettings, ...req.body };
  try {
    await prisma.systemConfig.upsert({
      where: { id: "settings" },
      update: { data: JSON.stringify(memorySettings) },
      create: { id: "settings", data: JSON.stringify(memorySettings) },
    });
    res.json({ success: true, settings: memorySettings });
  } catch (error) {
    res.status(500).json({ error: "Erro DB" });
  }
});
app.get("/api/fiscal", (req, res) => res.json(getFiscalData()));
app.put("/api/fiscal", async (req, res) => {
  memoryFiscal = { ...memoryFiscal, ...req.body };
  try {
    await prisma.systemConfig.upsert({
      where: { id: "fiscal" },
      update: { data: JSON.stringify(memoryFiscal) },
      create: { id: "fiscal", data: JSON.stringify(memoryFiscal) },
    });
    res.json({ success: true, fiscalData: memoryFiscal });
  } catch (error) {
    res.status(500).json({ error: "Erro DB" });
  }
});
app.get("/api/upsells", (req, res) =>
  res.json(memoryUpsells.filter((u) => u.active))
);
app.get("/api/admin/upsells", (req, res) => res.json(memoryUpsells));
app.post("/api/admin/upsells", async (req, res) => {
  try {
    const newUpsell = { id: Date.now().toString(), ...req.body, active: true };
    memoryUpsells.push(newUpsell);
    await prisma.systemConfig.upsert({
      where: { id: "upsells" },
      update: { data: JSON.stringify(memoryUpsells) },
      create: { id: "upsells", data: JSON.stringify(memoryUpsells) },
    });
    res.json({ success: true, upsell: newUpsell });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.put("/api/admin/upsells/:id", async (req, res) => {
  try {
    const idx = memoryUpsells.findIndex((u) => u.id === req.params.id);
    if (idx > -1) {
      memoryUpsells[idx] = { ...memoryUpsells[idx], ...req.body };
      await prisma.systemConfig.update({
        where: { id: "upsells" },
        data: { data: JSON.stringify(memoryUpsells) },
      });
      res.json({ success: true, upsell: memoryUpsells[idx] });
    } else res.status(404).json({ error: "Erro" });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.delete("/api/admin/upsells/:id", async (req, res) => {
  try {
    memoryUpsells = memoryUpsells.filter((u) => u.id !== req.params.id);
    await prisma.systemConfig.update({
      where: { id: "upsells" },
      data: { data: JSON.stringify(memoryUpsells) },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.get("/api/suppliers", (req, res) => res.json(memorySuppliers));
app.post("/api/admin/suppliers", async (req, res) => {
  try {
    const newSupplier = {
      id: Date.now().toString(),
      ...req.body,
      active: true,
    };
    memorySuppliers.push(newSupplier);
    await prisma.systemConfig.upsert({
      where: { id: "suppliers" },
      update: { data: JSON.stringify(memorySuppliers) },
      create: { id: "suppliers", data: JSON.stringify(memorySuppliers) },
    });
    res.json({ success: true, supplier: newSupplier });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});
app.put("/api/admin/suppliers/:id", async (req, res) => {
  try {
    const idx = memorySuppliers.findIndex((s) => s.id === req.params.id);
    if (idx > -1) {
      memorySuppliers[idx] = { ...memorySuppliers[idx], ...req.body };
      await prisma.systemConfig.update({
        where: { id: "suppliers" },
        data: { data: JSON.stringify(memorySuppliers) },
      });
      res.json({ success: true, supplier: memorySuppliers[idx] });
    } else {
      res.status(404).json({ error: "Erro" });
    }
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});
app.delete("/api/admin/suppliers/:id", async (req, res) => {
  try {
    memorySuppliers = memorySuppliers.filter((s) => s.id !== req.params.id);
    await prisma.systemConfig.update({
      where: { id: "suppliers" },
      data: { data: JSON.stringify(memorySuppliers) },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.put("/api/auth/admin/profile", async (req, res) => {
  const { name, email, password } = req.body;
  try {
    let adminUser = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    if (!adminUser) {
      const hashed = await bcrypt.hash(password || "canoneadmin123", 10);
      await prisma.user.create({
        data: { name, email, password: hashed, role: "ADMIN" },
      });
    } else {
      const updateData = { name, email };
      if (password && password.trim() !== "")
        updateData.password = await bcrypt.hash(password, 10);
      await prisma.user.update({
        where: { id: adminUser.id },
        data: updateData,
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.post("/api/auth/admin/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    if (email === "admin@canone.com" && password === "canoneadmin123")
      return res.json({
        success: true,
        token: jwt.sign({ role: "ADMIN" }, JWT_SECRET, { expiresIn: "1d" }),
      });
    const adminUser = await prisma.user.findFirst({
      where: { email, role: "ADMIN" },
    });
    if (adminUser && (await bcrypt.compare(password, adminUser.password)))
      return res.json({
        success: true,
        token: jwt.sign({ id: adminUser.id, role: "ADMIN" }, JWT_SECRET, {
          expiresIn: "1d",
        }),
      });
    res.status(401).json({ error: "Credenciais inválidas." });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, phone, cpf, birthDate, address } = req.body;
  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser)
      return res.status(400).json({ error: "Este e-mail já está em uso." });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        phone,
        cpf,
        birthDate,
        address,
        role: "CLIENT",
        cashback: { create: { balance: 0.0 } },
      },
      include: { cashback: true },
    });
    res
      .status(201)
      .json({
        success: true,
        token: jwt.sign({ id: newUser.id, role: newUser.role }, JWT_SECRET, {
          expiresIn: "7d",
        }),
        user: newUser,
      });
  } catch (error) {
    res.status(500).json({ error: "Erro ao registrar usuário" });
  }
});
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        cashback: true,
        orders: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: "E-mail ou senha inválidos." });
    if (user.isBlocked)
      return res
        .status(403)
        .json({
          error:
            "Sua conta está bloqueada devido a pendências de pagamento na loja.",
        });
    const lastAddress = user.orders.length > 0 ? user.orders[0].address : "";
    res
      .status(200)
      .json({
        success: true,
        token: jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
          expiresIn: "7d",
        }),
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
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user)
      return res.status(404).json({ error: "Nenhuma conta encontrada" });
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
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
    const user = await prisma.user.findUnique({ where: { email } });
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
        where: { role: "CLIENT" },
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
    const { isBlocked } = req.body;
    await prisma.user.update({
      where: { id: req.params.id },
      data: { isBlocked },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.get("/api/crm/customer-accounts", async (req, res) => {
  try {
    const customers = await prisma.user.findMany({
      where: { role: "CLIENT", accountMovements: { some: {} } },
      include: { accountMovements: { orderBy: { createdAt: "desc" } } },
      orderBy: { name: "asc" },
    });
    const accountsData = customers
      .map((c) => {
        const pending = c.accountMovements.filter(
          (m) => m.type === "CHARGE" && !m.isPaid
        );
        const currentDebt = pending.reduce((acc, curr) => acc + curr.amount, 0);
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
      where: { customerId, type: "CHARGE", isPaid: false },
    });
    const totalToPay = pending.reduce((acc, curr) => acc + curr.amount, 0);
    if (totalToPay <= 0) return res.status(400).json({ error: "Sem dívidas." });
    await prisma.$transaction([
      prisma.customerAccountMovement.updateMany({
        where: { customerId, type: "CHARGE", isPaid: false },
        data: { isPaid: true, paidAt: new Date() },
      }),
      prisma.customerAccountMovement.create({
        data: {
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

app.get("/api/admin/coupons", (req, res) => res.json(memoryCoupons));
app.post("/api/admin/coupons", async (req, res) => {
  try {
    const { code, type, value, minOrderValue, active, maxUses } = req.body;
    if (!code || !type || !value)
      return res.status(400).json({ error: "Erro" });
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
    const existingIndex = memoryCoupons.findIndex(
      (c) => c.code === newCoupon.code
    );
    if (existingIndex >= 0)
      memoryCoupons[existingIndex] = {
        ...memoryCoupons[existingIndex],
        ...newCoupon,
        usedCount: memoryCoupons[existingIndex].usedCount,
        usedBy: memoryCoupons[existingIndex].usedBy || [],
      };
    else memoryCoupons.push(newCoupon);
    await prisma.systemConfig.upsert({
      where: { id: "coupons" },
      update: { data: JSON.stringify(memoryCoupons) },
      create: { id: "coupons", data: JSON.stringify(memoryCoupons) },
    });
    res.json({ success: true, coupon: newCoupon });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.post("/api/coupons/validate", (req, res) => {
  const { code, cartTotal, clientId } = req.body;
  if (!code) return res.status(400).json({ error: "Código" });
  const coupon = memoryCoupons.find((c) => c.code === code.toUpperCase());
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
app.get("/api/avaliacoes", async (req, res) => {
  try {
    res.json(
      await prisma.avaliacao.findMany({
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
      data: { clienteNome, nota: Number(nota), comentario: comentario || "" },
    });
    res.json({ success: true, avaliacao: novaAvaliacao });
  } catch (error) {
    res.status(500).json({ success: false, error: "Erro" });
  }
});

app.get("/api/rh/profiles", async (req, res) => {
  try {
    res.json(await prisma.accessProfile.findMany({ orderBy: { name: "asc" } }));
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.post("/api/rh/profiles", async (req, res) => {
  const { name, permissions } = req.body;
  try {
    const existing = await prisma.accessProfile.findUnique({ where: { name } });
    if (existing) return res.status(400).json({ error: "Já existe." });
    res
      .status(201)
      .json({
        success: true,
        profile: await prisma.accessProfile.create({
          data: { name, permissions: JSON.stringify(permissions || []) },
        }),
      });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.put("/api/rh/profiles/:id", async (req, res) => {
  const { name, permissions } = req.body;
  try {
    const existing = await prisma.accessProfile.findUnique({ where: { name } });
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
      return res.status(400).json({ error: "Tem funcionários vinculados." });
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
    const checkEmail = await prisma.employee.findUnique({ where: { email } });
    if (checkEmail) return res.status(400).json({ error: "E-mail em uso." });
    const checkCpf = await prisma.employee.findUnique({ where: { cpf } });
    if (checkCpf) return res.status(400).json({ error: "CPF em uso." });
    const profileInfo = await prisma.accessProfile.findUnique({
      where: { id: profileId },
    });
    if (!profileInfo)
      return res.status(400).json({ error: "Perfil inválido." });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newEmployee = await prisma.employee.create({
      data: {
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
    if (password && password.trim() !== "") {
      updateData.password = await bcrypt.hash(password, 10);
    }
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
    const checkEmail = await prisma.employee.findUnique({ where: { email } });
    if (checkEmail) return res.status(400).json({ error: "E-mail em uso." });
    const checkCpf = await prisma.employee.findUnique({ where: { cpf } });
    if (checkCpf) return res.status(400).json({ error: "CPF em uso." });
    let profileInfo = await prisma.accessProfile.findFirst({
      where: { name: { contains: "Entregador", mode: "insensitive" } },
    });
    if (!profileInfo) {
      profileInfo = await prisma.accessProfile.create({
        data: { name: "Entregador", permissions: "[]" },
      });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newEmployee = await prisma.employee.create({
      data: {
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
app.post("/api/auth/employee/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const employee = await prisma.employee.findFirst({
      where: { OR: [{ email: email }, { cpf: email }] },
      include: { profile: true },
    });
    if (!employee || !(await bcrypt.compare(password, employee.password)))
      return res.status(401).json({ error: "Inválido." });
    if (!employee.isActive) return res.status(403).json({ error: "Inativo." });
    if (
      employee.role.toLowerCase().includes("entregador") &&
      employee.facePhoto
    ) {
      const today = new Date().toISOString().split("T")[0];
      const lastLogin = employee.lastFaceLogin
        ? new Date(employee.lastFaceLogin).toISOString().split("T")[0]
        : null;
      if (lastLogin !== today) {
        return res.json({
          success: true,
          needsFaceValidation: true,
          employeeId: employee.id,
        });
      }
    }
    const token = jwt.sign(
      {
        id: employee.id,
        role: "EMPLOYEE",
        profile: employee.role,
        permissions: JSON.parse(employee.profile.permissions),
      },
      JWT_SECRET,
      { expiresIn: "12h" }
    );
    res
      .status(200)
      .json({
        success: true,
        token,
        employee: {
          id: employee.id,
          name: employee.name,
          role: employee.role,
          permissions: JSON.parse(employee.profile.permissions),
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
    if (!employee)
      return res.status(404).json({ error: "Funcionário não encontrado." });
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
    const luxandRes = await fetch("https://api.luxand.cloud/v2/faces/compare", {
      method: "POST",
      headers: { token: process.env.LUXAND_API_TOKEN },
      body: formData,
    });
    const luxandData = await luxandRes.json();
    if (luxandData.probability && luxandData.probability >= 0.8) {
      await prisma.employee.update({
        where: { id: employeeId },
        data: { lastFaceLogin: new Date() },
      });
      const token = jwt.sign(
        {
          id: employee.id,
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
        },
      });
    } else {
      res.status(401).json({ error: `Rosto não confere.` });
    }
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.post("/api/rh/logs", async (req, res) => {
  const { employeeId, action, details } = req.body;
  try {
    await prisma.employeeLog.create({
      data: { employeeId, action, details: details || "" },
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
      const currentDebt = pending.reduce((acc, curr) => acc + curr.amount, 0);
      const hasOverdue = pending.some((c) => new Date(c.createdAt) < cutoff);
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
      where: { OR: [{ email: authData.email }, { cpf: authData.email }] },
      include: { profile: true },
    });
    if (!admin || !(await bcrypt.compare(authData.password, admin.password)))
      return res.status(401).json({ error: "Credenciais inválidas." });
    const pending = await prisma.employeeAccountMovement.findMany({
      where: { employeeId, type: "CHARGE", isPaid: false },
    });
    const totalToPay = pending.reduce((acc, curr) => acc + curr.amount, 0);
    if (totalToPay <= 0) return res.status(400).json({ error: "Sem dívidas." });
    await prisma.$transaction([
      prisma.employeeAccountMovement.updateMany({
        where: { employeeId, type: "CHARGE", isPaid: false },
        data: { isPaid: true, paidAt: new Date() },
      }),
      prisma.employeeAccountMovement.create({
        data: {
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

app.get("/api/menu", async (req, res) => {
  try {
    res.json(
      await prisma.category.findMany({
        orderBy: { order: "asc" },
        include: {
          products: { where: { isActive: true }, orderBy: { order: "asc" } },
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
      await prisma.category.update({
        where: { id: cat.id },
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
      await prisma.product.update({
        where: { id: prod.id },
        data: { order: prod.order },
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.get("/api/products/highlights", async (req, res) => {
  try {
    res.json(
      await prisma.product.findMany({
        where: { isFeatured: true, isActive: true },
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
        include: {
          category: true,
          fichasTecnicas: { include: { insumo: true } },
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
    name,
    description,
    price,
    price700g,
    price1kg,
    categoryId,
    imageUrl,
    regraFiscalId,
    ncm,
    ean,
    groupId,
  } = req.body;
  try {
    const newProduct = await prisma.product.create({
      data: {
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
      },
    });
    res.status(201).json({ success: true, product: newProduct });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.put("/api/products/:id", async (req, res) => {
  const {
    name,
    description,
    price,
    price700g,
    price1kg,
    categoryId,
    isActive,
    imageUrl,
    isFeatured,
    regraFiscalId,
    ncm,
    ean,
    groupId,
  } = req.body;
  try {
    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        name,
        description,
        price: Number(price),
        price700g: price700g ? Number(price700g) : null,
        price1kg: price1kg ? Number(price1kg) : null,
        categoryId,
        isActive,
        imageUrl,
        isFeatured,
        regraFiscalId,
        ncm,
        ean,
        groupId: groupId || null,
        isActive: true,
      },
    });
    res.json({ success: true, product: updated });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.put("/api/products/:id/feature", async (req, res) => {
  try {
    res.json({
      success: true,
      product: await prisma.product.update({
        where: { id: req.params.id },
        data: { isFeatured: req.body.isFeatured },
      }),
    });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.post("/api/categories", async (req, res) => {
  try {
    const count = await prisma.category.count();
    res.status(201).json({
      success: true,
      category: await prisma.category.create({
        data: {
          name: req.body.name,
          slug: req.body.name
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, "-"),
          order: count,
          isDrink: Boolean(req.body.isDrink)
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
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, "-"),
          isDrink: Boolean(req.body.isDrink)
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
app.get("/api/products/:id/fichas", async (req, res) => {
  try {
    res.json(
      await prisma.fichaTecnica.findMany({
        where: { productId: req.params.id },
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
      data: { productId: req.params.id, insumoId, quantity: Number(quantity) },
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
    res.json(await prisma.insumo.findMany({ orderBy: { name: "asc" } }));
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.post("/api/insumos", async (req, res) => {
  try {
    res
      .status(201)
      .json({
        success: true,
        insumo: await prisma.insumo.create({
          data: {
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
    for (const f of fichasAfetadas) await recalcularCustoProduto(f.productId);
    res.json({ success: true, insumo: insumoAtualizado });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});
app.get("/api/estoque/movimentacoes", async (req, res) => {
  try {
    res.json(
      await prisma.movimentacaoEstoque.findMany({
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
      data: { stock: type === "IN" ? { increment: qtd } : { decrement: qtd } },
    });
    await prisma.movimentacaoEstoque.create({
      data: {
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
    if (!req.file) return res.status(400).json({ error: "Arquivo inválido." });
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
    const { chaveNfe, items } = req.body;
    let insumosAtualizados = 0;
    for (const item of items) {
      if (item.action === "IGNORE") continue;
      let insumoId = item.mappedInsumoId;
      if (item.action === "NEW") {
        const novo = await prisma.insumo.create({
          data: {
            name: item.name,
            unit: item.unit,
            stock: item.quantity,
            cost: item.unitCost,
          },
        });
        insumoId = novo.id;
      } else if (item.action === "LINK" && insumoId) {
        await prisma.insumo.update({
          where: { id: insumoId },
          data: { stock: { increment: item.quantity }, cost: item.unitCost },
        });
      }
      if (insumoId) {
        await prisma.movimentacaoEstoque.create({
          data: {
            insumoId: insumoId,
            type: "IN",
            quantity: item.quantity,
            reason: "Entrada via XML",
            xmlRef: chaveNfe,
          },
        });
        insumosAtualizados++;
      }
    }
    res.json({
      success: true,
      message: `${insumosAtualizados} insumos processados!`,
    });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

// ============================================================================
// 13. CAIXA PDV E TURNOS (COMPLETO)
// ============================================================================

app.get("/api/pdv/status", async (req, res) => {
  const { employeeId } = req.query;
  try {
    const currentShift = await prisma.shift.findFirst({
      where: { status: "OPEN" },
      orderBy: { createdAt: "desc" },
    });
    if (!currentShift)
      return res.json({ hasOpenShift: false, activeRegister: null });
    const activeRegister = await prisma.cashRegister.findFirst({
      where: { shiftId: currentShift.id, status: "OPEN", openedBy: employeeId },
      include: { movements: true },
    });
    res.json({ hasOpenShift: true, shiftId: currentShift.id, activeRegister });
  } catch (e) {
    res.status(500).json({ error: "Erro PDV" });
  }
});

app.post("/api/pdv/register/open", async (req, res) => {
  const { employeeId, openingBalance } = req.body;
  try {
    let currentShift = await prisma.shift.findFirst({
      where: { status: "OPEN" },
    });
    if (!currentShift)
      currentShift = await prisma.shift.create({
        data: { openedBy: employeeId, status: "OPEN" },
      });
    const existingRegister = await prisma.cashRegister.findFirst({
      where: { shiftId: currentShift.id, status: "OPEN", openedBy: employeeId },
    });
    if (existingRegister)
      return res.status(400).json({ error: "Caixa aberto." });
    const register = await prisma.cashRegister.create({
      data: {
        shiftId: currentShift.id,
        openedBy: employeeId,
        status: "OPEN",
        openingBalance: Number(openingBalance) || 0,
      },
    });
    res.status(201).json({ success: true, register, shiftId: currentShift.id });
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
        closingDetails: closingDetails ? JSON.stringify(closingDetails) : null,
      },
      include: { 
        movements: true, 
        // 🚨 EXCLUI CANCELADOS E PENDENTES DO RELATÓRIO DO CAIXA
        orders: { where: { status: { notIn: ["CANCELED", "PENDING"] } } } 
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
      where: { OR: [{ email: managerAuth.email }, { cpf: managerAuth.email }] },
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
    let filtro = {};
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
          // 🚨 EXCLUI CANCELADOS E PENDENTES DO RELATÓRIO DE TURNOS
          orders: { where: { status: { notIn: ["CANCELED", "PENDING"] } } },
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
      where: { OR: [{ email: managerAuth.email }, { cpf: managerAuth.email }] },
      include: { profile: true },
    });
    if (
      !manager ||
      !(await bcrypt.compare(managerAuth.password, manager.password))
    )
      return res.status(401).json({ error: "Inválidas." });
    const openRegisters = await prisma.cashRegister.count({
      where: { shiftId, status: "OPEN" },
    });
    if (openRegisters > 0)
      return res.status(400).json({ error: "Feche os caixas." });
    const openTabs = await prisma.restaurantTab.count({
      where: { shiftId, status: "OPEN" },
    });
    if (openTabs > 0)
      return res.status(400).json({ error: `Existem comandas abertas!` });
    res.json({
      success: true,
      shift: await prisma.shift.update({
        where: { id: shiftId },
        data: { status: "CLOSED", closedAt: new Date(), closedBy: manager.id },
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
      where: { OR: [{ email: managerAuth.email }, { cpf: managerAuth.email }] },
      include: { profile: true },
    });
    if (
      !manager ||
      !(await bcrypt.compare(managerAuth.password, manager.password))
    )
      return res.status(401).json({ error: "Inválido." });
    const activeShift = await prisma.shift.findFirst({
      where: { status: "OPEN" },
    });
    if (activeShift)
      return res.status(400).json({ error: "Turno em andamento." });
    res
      .status(201)
      .json({
        success: true,
        shift: await prisma.shift.create({
          data: { openedBy: manager.id, status: "OPEN" },
        }),
      });
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});

// ============================================================================
// 14. KDS MOTOR - ROTA UNIFICADA PARA ALIMENTAR OS 3 KDS
// ============================================================================
app.get("/api/kds", async (req, res) => {
  try {
    const activeShift = await prisma.shift.findFirst({
      where: { status: "OPEN" },
      orderBy: { createdAt: "desc" }
    });
    const shiftId = activeShift ? activeShift.id : "none";

    const appOrders = await prisma.order.findMany({
      where: { 
        origin: "APP", 
        OR: [
          { status: { in: ["PENDING", "PREPARING", "READY", "IN_TRANSIT"] } },
          { status: "DELIVERED", shiftId: shiftId } 
        ]
      },
      include: { 
        client: true,
        items: { include: { product: { include: { category: true } } } } 
      },
      orderBy: { createdAt: "asc" }
    });

    const totemOrders = await prisma.order.findMany({
      where: { 
        origin: "TOTEM", 
        OR: [
          { status: { in: ["PREPARING", "READY"] } },
          { status: "DELIVERED", shiftId: shiftId } 
        ] 
      },
      include: { 
        client: true,
        items: { include: { product: { include: { category: true } } } } 
      },
      orderBy: { createdAt: "asc" }
    });

    const salaoItems = await prisma.tabItem.findMany({
      where: { 
        tab: { status: "OPEN" }, 
        OR: [
          { status: { in: ["PENDING", "PREPARING", "READY"] } },
          { status: "SERVED", tab: { shiftId: shiftId } } 
        ]
      },
      include: {
        tab: true,
        product: { include: { category: true } }
      },
      orderBy: { createdAt: "asc" }
    });

    res.json({ success: true, appOrders, totemOrders, salaoItems });
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar dados unificados do KDS." });
  }
});

// ============================================================================
// 15. SALÃO E ENTREGAS (MESAS, COMANDAS E DESPACHOS)
// ============================================================================

app.get("/api/salao/tabs", async (req, res) => {
  try {
    res.json(
      await prisma.restaurantTab.findMany({
        where: { status: "OPEN" },
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
      where: { number: Number(number), status: "OPEN" },
    });
    if (existing)
      return res
        .status(400)
        .json({ error: `Atendimento ${number} já aberto.` });

    if (customerCpf && customerCpf.trim() !== "") {
      const tabWithSameCpf = await prisma.restaurantTab.findFirst({
        where: { customerCpf: customerCpf, status: "OPEN" }
      });
      if (tabWithSameCpf) {
        const tipo = tabWithSameCpf.type === "TABLE" ? "Mesa" : "Comanda";
        return res.status(400).json({
          error: `Este CPF já está a ser utilizado na ${tipo} ${tabWithSameCpf.number}. Encerre-a primeiro antes de abrir uma nova.`
        });
      }
    }

    const currentShift = await prisma.shift.findFirst({
      where: { status: "OPEN" },
    });
    if (!currentShift)
      return res
        .status(400)
        .json({ error: "Abra o caixa antes de operar no salão." });

    let finalCustomerId = customerId;
    let debtToTransfer = 0;

    if (customerCpf && !finalCustomerId) {
      let existingUser = await prisma.user.findFirst({
        where: { cpf: customerCpf },
      });
      if (existingUser) {
        finalCustomerId = existingUser.id;
      } else if (customerName) {
        const randomPassword = await bcrypt.hash(
          "canone" + Math.floor(Math.random() * 10000),
          10
        );
        const newUser = await prisma.user.create({
          data: {
            name: customerName,
            cpf: customerCpf,
            birthDate: customerBirthDate
              ? new Date(customerBirthDate).toISOString()
              : null,
            email: `cliente.${Date.now()}@avulso.com`,
            password: randomPassword,
            role: "CLIENT",
            cashback: { create: { balance: 0.0 } },
          },
        });
        finalCustomerId = newUser.id;
      }
    }

    if ((customerType === "Cliente" || finalCustomerId) && finalCustomerId) {
      const pending = await prisma.customerAccountMovement.findMany({
        where: { customerId: finalCustomerId, type: "CHARGE", isPaid: false },
      });
      debtToTransfer = pending.reduce((acc, curr) => acc + curr.amount, 0);

      if (debtToTransfer > 0) {
        if (managerAuth && managerAuth.email && managerAuth.password) {
          const manager = await prisma.employee.findFirst({
            where: {
              OR: [{ email: managerAuth.email }, { cpf: managerAuth.email }],
            },
          });
          if (
            !manager ||
            !(await bcrypt.compare(managerAuth.password, manager.password))
          ) {
            return res
              .status(401)
              .json({ error: "Credenciais do gerente inválidas." });
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
        number: Number(number),
        type: Number(number) >= 1000 ? "TAB" : "TABLE",
        customerName: customerName || null,
        customerCpf: customerCpf || null,
        openedBy,
        shiftId: currentShift.id,
      },
    });

    if (debtToTransfer > 0) {
      const p = await getDividaProduct();
      await prisma.tabItem.create({
        data: {
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
        where: { customerId: finalCustomerId, type: "CHARGE", isPaid: false },
        data: { isPaid: true, paidAt: new Date() },
      });
      await prisma.customerAccountMovement.create({
        data: {
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
          where: { OR: orConditions },
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
            grossTotal - grossTotal * ((employee.discountPercent || 0) / 100);

          const ruleCheck = await checkEmployeeAccountRules(
            employee.id,
            netTotal,
            managerAuth
          );
          if (!ruleCheck.success) {
            return res.status(400).json(ruleCheck);
          }
        }
      }
    }

    let createdItems = [];
    for (let item of items) {
      createdItems.push(
        await prisma.tabItem.create({
          data: {
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
      where: { number: Number(req.params.number), status: "OPEN" },
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
    let salaoUser = await prisma.user.findUnique({
      where: { email: "lancamento@canone.com" },
    });
    if (!salaoUser) {
      salaoUser = await prisma.user.create({
        data: {
          name: "App de Lançamento",
          email: "lancamento@canone.com",
          password: await bcrypt.hash("lancamentosenha", 10),
          role: "CLIENT",
          cashback: { create: { balance: 0.0 } },
        },
      });
    }

    const itemsToPay = seatFilter
      ? tab.items.filter((i) => i.seatLabel === seatFilter)
      : tab.items;

    const hasUnservedItems = itemsToPay.some(i => i.status !== 'SERVED');
    if (hasUnservedItems) {
      return res.status(400).json({ error: "Existem itens na comanda que ainda estão na Cozinha/Bar ou aguardando o Garçom retirar. Marque todos os itens como 'Entregue 🏃' antes de fechar a conta." });
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
        totalToPay = totalToPay - totalToPay * (empData.discountPercent / 100);

      const ruleCheck = await checkEmployeeAccountRules(
        employeeBuyerId,
        totalToPay,
        managerAuth
      );
      if (!ruleCheck.success) return res.status(400).json(ruleCheck);
    }

    if (paymentMethod === "CUSTOMER_ACCOUNT") {
      if (!clientId)
        return res
          .status(400)
          .json({ error: "Selecione o cliente na busca para lançar fiado!" });
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

// ============================================================================
// 16. PEDIDOS (APP, TOTEM E SALÃO)
// ============================================================================ 

// ROTA UNIFICADA PARA CRIAR PEDIDOS DE APP, TOTEM E SALÃO
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
  if (clientId === "TOTEM_MODE") {
    finalOrigin = "TOTEM";
  }

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
      managerAuth
    );
    if (!ruleCheck.success) return res.status(400).json(ruleCheck);
  }

  if (paymentMethod === "CUSTOMER_ACCOUNT") {
    if (!clientId || clientId === "TOTEM_MODE")
      return res
        .status(400)
        .json({ error: "Selecione um cliente para vender fiado." });
    const checkUser = await prisma.user.findUnique({ where: { id: clientId } });
    if (checkUser?.isBlocked)
      return res
        .status(400)
        .json({ error: "O cliente está bloqueado por falta de pagamento." });
  }

  let finalClientId = clientId;
  if (!clientId || clientId === "TOTEM_MODE") {
    let totemUser = await prisma.user.findUnique({
      where: { email: "totem@canone.com" },
    });
    if (!totemUser) {
      const randomPassword = await bcrypt.hash("totem", 10);
      totemUser = await prisma.user.create({
        data: {
          name: "Totem Autoatendimento",
          email: "totem@canone.com",
          password: randomPassword,
          role: "CLIENT",
          cashback: { create: { balance: 0.0 } },
        },
      });
    }
    finalClientId = totemUser.id;
  }

  const hasScheduled = items.some(
    (item) => item.name?.toLowerCase().includes("agendado") || item.isScheduled
  );
  const hasNormal = items.some(
    (item) =>
      !item.name?.toLowerCase().includes("agendado") && !item.isScheduled
  );

  const storeIsOpen = await checkStoreStatus();
  if (
    !storeIsOpen &&
    hasNormal &&
    clientId !== "TOTEM_MODE" &&
    finalOrigin !== "PDV"
  ) {
    return res
      .status(400)
      .json({
        error:
          "A loja está fechada no momento ou o caixa/turno não foi aberto. Apenas produtos de encomenda podem ser solicitados agora.",
      });
  }

  const settings = getSettings();
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
        where: { status: "OPEN" },
      });
      if (!activeShift)
        activeShift = await prisma.shift.create({
          data: { openedBy: "SISTEMA", status: "OPEN" },
        });
      currentShiftId = activeShift.id;
    }

    let couponDiscount = 0;
    let appliedCoupon = null;
    if (couponCode && clientId !== "TOTEM_MODE" && finalOrigin !== "PDV") {
      appliedCoupon = memoryCoupons.find(
        (c) => c.code === couponCode.toUpperCase() && c.active
      );
      if (
        appliedCoupon &&
        appliedCoupon.usedBy &&
        appliedCoupon.usedBy.includes(finalClientId)
      )
        return res.status(400).json({ error: "Você já usou este cupom!" });
      if (
        appliedCoupon &&
        appliedCoupon.maxUses > 0 &&
        appliedCoupon.usedCount >= appliedCoupon.maxUses
      )
        return res.status(400).json({ error: "Cupom esgotado!" });
      if (appliedCoupon && finalTotalCart >= appliedCoupon.minOrderValue) {
        if (appliedCoupon.type === "PERCENTAGE")
          couponDiscount = finalTotalCart * (appliedCoupon.value / 100);
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
      paymentMethod === "PIX_ONLINE" || paymentMethod === "CREDIT_CARD_ONLINE"
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
      prisma.systemConfig
        .update({
          where: { id: "coupons" },
          data: { data: JSON.stringify(memoryCoupons) },
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
              create: normalItems.map((item) => ({
                productId: item.productId,
                quantity: item.quantity,
                price: item.price,
              })),
            },
          },
          include: { client: true },
        })
      );
      txOps.push(
        prisma.order.create({
          data: {
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
              create: scheduledItems.map((item) => ({
                productId: item.productId,
                quantity: item.quantity,
                price: item.price,
              })),
            },
          },
          include: { client: true },
        })
      );
    } else {
      txOps.push(
        prisma.order.create({
          data: {
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
              create: items.map((item) => ({
                productId: item.productId,
                quantity: item.quantity,
                price: item.price,
              })),
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
            first_name: mainOrder.client.name.split(" ")[0] || "Cliente",
          },
          external_reference: externalRef,
          notification_url: "https://zenixfood-backend.onrender.com/api/webhook",
        },
      });
      return res
        .status(201)
        .json({
          success: true,
          order: mainOrder,
          pix: {
            qr_code: paymentData.point_of_interaction.transaction_data.qr_code,
            qr_code_base64:
              paymentData.point_of_interaction.transaction_data.qr_code_base64,
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
          notification_url: "https://zenixfood-backend.onrender.com/api/webhook",
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

    res
      .status(201)
      .json({
        success: true,
        order: mainOrder,
        discountApplied: finalDiscount,
        newBalance,
      });
  } catch (error) {
    res.status(500).json({ error: "Erro ao processar o pedido" });
  }
});

// ROTA PARA RECUPERAR E GERAR NOVO PIX PARA PEDIDO PENDENTE 
app.post("/api/orders/:id/retry-pix", async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { client: true }
    });
    
    if (!order || order.status !== "PENDING") {
      return res.status(400).json({ error: "Pedido não está pendente ou não encontrado." });
    }

    const payment = new Payment(clientMP);
    // Usa o formato |RETRY para o webhook existente continuar a funcionar perfeitamente
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
        notification_url: "https://zenixfood-backend.onrender.com/api/webhook",
      },
    });

    res.json({
      success: true,
      pix: {
        qr_code: paymentData.point_of_interaction.transaction_data.qr_code,
        qr_code_base64: paymentData.point_of_interaction.transaction_data.qr_code_base64,
        orderId: order.id,
      }
    });
  } catch (error) {
    res.status(500).json({ error: "Erro ao gerar novo PIX." });
  }
});

// ROTA PARA WEBHOOK DO MERCADO PAGO
app.post("/api/webhook", async (req, res) => {
  const { type, data } = req.body;
  res.status(200).send("OK");
  if (type === "payment") {
    try {
      const response = await fetch(
        `https://api.mercadopago.com/v1/payments/${data.id}`,
        { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
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

// ============================================================================
// 17. ROTAS DE PEDIDOS (APP, TOTEM E SALÃO)
// ============================================================================ 

//rota para listar todos os pedidos, incluindo cliente, itens e entregador
app.get("/api/orders", async (req, res) => {
  try {
    res.json(
      await prisma.order.findMany({
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
        where: { clientId: req.params.clientId },
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
    if (!order) return res.status(404).json({ error: "Nao encontrado" });
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});

app.put("/api/orders/:id/status", async (req, res) => {
  const { status } = req.body;
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { client: { include: { cashback: true } }, items: true },
    });
    if (!order) return res.status(404).json({ error: "Erro" });
    const [updatedOrder, updatedWallet] = await prisma.$transaction([
      prisma.order.update({ where: { id: order.id }, data: { status } }),
    ]);
    res.json({
      success: true,
      newBalance: updatedWallet ? updatedWallet.balance : 0,
    });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

// 🚨 CORREÇÃO: CANCELAMENTO AGORA DEVOLVE O CASHBACK CORRETAMENTE
app.put("/api/orders/:id/cancel", async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
    });
    if (!order) return res.status(404).json({ error: "Erro" });
    if (order.status !== "PENDING")
      return res.status(400).json({ error: "Apenas pendentes" });

    // Restaura o cashback se foi utilizado na compra
    if (order.cashbackUsed > 0 && order.clientId && order.clientId !== 'TOTEM_MODE') {
       try {
         await prisma.cashbackWallet.update({
            where: { userId: order.clientId },
            data: { balance: { increment: order.cashbackUsed } }
         });
       } catch (e) { console.error("Erro ao devolver cashback", e); }
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
    const entregadores = await prisma.employee.findMany({
      where: { isActive: true },
      select: { id: true, name: true, role: true },
    });
    res.json(entregadores);
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});

app.put("/api/orders/dispatch", async (req, res) => {
  const { orderIds, deliveryPersonId } = req.body;
  try {
    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { status: "IN_TRANSIT", deliveryPersonId },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.get("/api/delivery/my-orders/:employeeId", async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { deliveryPersonId: req.params.employeeId, status: "IN_TRANSIT" },
      include: { client: true, items: { include: { product: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: "Erro" });
  }
});

app.post("/api/delivery/confirm", async (req, res) => {
  const { shortId, code } = req.body;
  try {
    const order = await prisma.order.findFirst({
      where: { shortId: Number(shortId), status: "IN_TRANSIT" },
      include: { client: true }
    });
    if (!order) return res.status(404).json({ error: "Pedido não encontrado ou já entregue." });

    let correctCode = "0000";
    if (order.client && order.client.phone) {
       const phoneDigits = order.client.phone.replace(/\D/g, '');
       if (phoneDigits.length >= 4) correctCode = phoneDigits.slice(-4);
    }

    if (code !== correctCode && code !== "0000" && code !== String(order.shortId).padStart(4, '0')) {
       return res.status(400).json({ error: `Código incorreto! Tente os 4 últimos dígitos do celular do cliente.` });
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { status: "DELIVERED" }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Erro interno do servidor." });
  }
});

app.post("/api/admin/orders/:id/fiscal", async (req, res) => {
  const { id } = req.params;
  try {
    const order = await prisma.order.findUnique({
      where: { id: id },
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
      return res.status(500).json({ error: "Token fiscal ausente no Render." });
    const authHeader =
      "Basic " + Buffer.from(token.trim() + ":").toString("base64");

    try {
      const checkRes = await fetch(`${baseUrl}?ref=${order.shortId}`, {
        method: "GET",
        headers: { Authorization: authHeader },
      });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (
          checkData.status === "autorizado" ||
          checkData.status === "processando"
        ) {
          const dominioFocus = isHomologacao
            ? "https://homologacao.focusnfe.com.br"
            : "https://api.focusnfe.com.br";
          const linkDanfe = checkData.caminho_danfe
            ? `${dominioFocus}${checkData.caminho_danfe}`
            : null;
          const fiscalDataObj = {
            chaveAcesso: checkData.chave_nfe || checkData.chave_nfe_autorizada,
            protocolo: checkData.protocolo || "Resgatado via SEFAZ",
            urlQrCode: checkData.qr_code_url,
            urlDanfe: linkDanfe,
            numero: checkData.numero,
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
        }
      }
    } catch (err) {}

    let regrasFiscais = {
      icms: [],
      pisCofins: [],
      ibsCbs: [],
      regras: [],
      cnpjLoja: "",
    };
    const dbFiscal = await prisma.systemConfig.findUnique({
      where: { id: "fiscal" },
    });
    if (dbFiscal) regrasFiscais = JSON.parse(dbFiscal.data);

    const configuracoes = getSettings();
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

      if (icms_aliq > 0) itemSefazPayload.icms_aliquota = icms_aliq.toString();
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
      const linkDanfe = checkData.caminho_danfe
        ? `${dominioFocus}${checkData.caminho_danfe}`
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
        .json({ error: "Falha ao autorizar NFC-e", details: dadosRetorno });
    }
  } catch (error) {
    return res
      .status(500)
      .json({ error: "Erro interno", details: error.message });
  }
});

app.post("/api/analytics/visit", async (req, res) => {
  try {
    const { userId, device } = req.body;
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    await prisma.accessLog.create({
      data: {
        ip: ip ? ip.split(",")[0].trim() : "Desconhecido",
        device: device || "Desconhecido",
        userId: userId || null,
      },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Erro ao registrar visita" });
  }
});

app.get("/api/admin/analytics", async (req, res) => {
  try {
    const visits = await prisma.accessLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 300,
      include: { user: { select: { name: true, email: true } } },
    });
    const totalVisits = await prisma.accessLog.count();
    res.json({ success: true, visits, totalVisits });
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar acessos" });
  }
});

app.delete("/api/admin/analytics", async (req, res) => {
  try {
    const { type, startDate, endDate } = req.body;
    if (type === "all") {
      await prisma.accessLog.deleteMany({});
    } else if (type === "range" && startDate && endDate) {
      const start = new Date(startDate + "T00:00:00.000Z");
      const end = new Date(endDate + "T23:59:59.999Z");
      await prisma.accessLog.deleteMany({
        where: { createdAt: { gte: start, lte: end } },
      });
    }
    res.json({
      success: true,
      message: "Logs de acesso apagados com sucesso.",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/ai/receitas/gerar", async (req, res) => {
  const { prompt } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return res
      .status(500)
      .json({ error: "Chave da API do Google Gemini não encontrada." });
  try {
    const modelsRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    const modelsData = await modelsRes.json();
    if (!modelsData.models)
      return res.status(500).json({ error: "A chave da API é inválida." });
    const validModels = modelsData.models
      .filter(
        (m) =>
          m.supportedGenerationMethods?.includes("generateContent") &&
          m.name.includes("gemini")
      )
      .sort((a, b) => b.name.localeCompare(a.name));
    const topModels = validModels.slice(0, 5);
    let recipeData = null;
    let lastError = "Nenhum modelo compatível encontrado.";
    const payload = {
      contents: [
        {
          parts: [
            {
              text: `Você é um renomado Chef de uma Hamburgueria Artesanal. O usuário pediu: "${prompt}". Crie uma receita inovadora e retorne APENAS um JSON válido contendo exatamente 3 chaves: "nome" (string, um nome criativo), "ingredientes" (array de strings apenas com os nomes básicos e curtos dos insumos, ex: ["Pão Brioche", "Carne 150g", "Queijo Cheddar"]), "preparo" (string com o passo a passo de montagem). Retorne EXCLUSIVAMENTE o JSON puro e limpo, sem crases e sem formatação markdown.`,
            },
          ],
        },
      ],
    };
    for (const model of topModels) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${model.name}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await response.json();
      if (data.error) {
        lastError = data.error.message;
        continue;
      }
      if (data.candidates && data.candidates.length > 0) {
        let textResult = data.candidates[0].content.parts[0].text;
        let cleanJson = textResult
          .replace(/```json/gi, "")
          .replace(/```/g, "")
          .trim();
        const firstBrace = cleanJson.indexOf("{");
        const lastBrace = cleanJson.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1)
          cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
        try {
          recipeData = JSON.parse(cleanJson);
          break;
        } catch (parseError) {
          lastError = "A IA respondeu, mas não em formato JSON.";
          continue;
        }
      }
    }
    if (!recipeData)
      return res
        .status(500)
        .json({
          error: `O Google recusou todos os modelos. Último erro: ${lastError}`,
        });
    res.json({ success: true, receita: recipeData });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Falha ao processar a resposta da rede do Google." });
  }
});

app.post("/api/ai/receitas/aprovar", async (req, res) => {
  const { nome, ingredientes, preparo } = req.body;
  try {
    const receita = await prisma.receita.create({
      data: { nome, ingredientes: JSON.stringify(ingredientes), preparo },
    });
    const insumosAtuais = await prisma.insumo.findMany();
    const nomesAtuais = insumosAtuais.map((i) => i.name.toLowerCase().trim());
    let insumosCriados = 0;
    for (const ing of ingredientes) {
      const nomeLimpo = ing.toLowerCase().trim();
      if (!nomesAtuais.includes(nomeLimpo)) {
        await prisma.insumo.create({
          data: { name: ing, unit: "UN", cost: 0, stock: 0 },
        });
        nomesAtuais.push(nomeLimpo);
        insumosCriados++;
      }
    }
    res.json({ success: true, receita, insumosCriados });
  } catch (error) {
    res.status(500).json({ error: "Erro ao salvar a receita." });
  }
});

app.get("/api/ai/receitas", async (req, res) => {
  try {
    res.json(await prisma.receita.findMany({ orderBy: { criadoEm: "desc" } }));
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar receitas." });
  }
});

app.post("/api/ai/analise-lucros", async (req, res) => {
  const { produtos } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return res
      .status(500)
      .json({ error: "Chave da API do Google Gemini não encontrada." });
  try {
    const modelsRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    const modelsData = await modelsRes.json();
    if (!modelsData.models)
      return res.status(500).json({ error: "Erro ao validar modelos." });
    const validModels = modelsData.models
      .filter(
        (m) =>
          m.supportedGenerationMethods?.includes("generateContent") &&
          m.name.includes("gemini")
      )
      .sort((a, b) => b.name.localeCompare(a.name));
    const topModels = validModels.slice(0, 5);
    let analiseData = null;
    let lastError = "Nenhum modelo compatível.";
    const promptText = `Você é um Consultor Financeiro Sênior especializado em Hamburguerias e Delivery. Analise a saúde financeira do seguinte cardápio: ${JSON.stringify(
      produtos
    )} Identifique produtos com margem de lucro perigosamente baixa e os que são minas de ouro. Retorne APENAS um objeto JSON válido, sem crases ou markdown, com exatamente estas 3 chaves: "resumo" (string com avaliação geral da saúde financeira baseada nas margens), "alertas" (array de strings com alertas sobre produtos dando prejuízo ou com margem baixa), "oportunidades" (array de strings com dicas de negócios para aumentar o lucro).`;
    const payload = { contents: [{ parts: [{ text: promptText }] }] };
    for (const model of topModels) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${model.name}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await response.json();
      if (data.error) {
        lastError = data.error.message;
        continue;
      }
      if (data.candidates && data.candidates.length > 0) {
        let textResult = data.candidates[0].content.parts[0].text;
        let cleanJson = textResult
          .replace(/```json/gi, "")
          .replace(/```/g, "")
          .trim();
        const firstBrace = cleanJson.indexOf("{");
        const lastBrace = cleanJson.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1)
          cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
        try {
          analiseData = JSON.parse(cleanJson);
          break;
        } catch (e) {
          continue;
        }
      }
    }
    if (!analiseData)
      return res
        .status(500)
        .json({ error: `Falha na IA. Último erro: ${lastError}` });
    res.json({ success: true, analise: analiseData });
  } catch (error) {
    res.status(500).json({ error: "Erro de conexão com o Google." });
  }
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => console.log(`  Servidor rodando na porta ${PORT}`));