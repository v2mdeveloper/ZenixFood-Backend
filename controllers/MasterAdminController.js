const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const MasterAdminController = {
  // Lista todas as lojas cadastradas na plataforma Zenix
  async listAllStores(req, res) {
    try {
      const stores = await prisma.store.findMany({
        orderBy: { createdAt: 'desc' }
      });
      return res.json(stores);
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao buscar lojas.' });
    }
  },

  // Atualiza Módulos e Valores (Ex: O cliente comprou o Totem)
  async updateStoreModules(req, res) {
    const { id } = req.params;
    const { activeDelivery, activeTotem, activeKds, activeFiscal, monthlyFee, subscriptionStatus, subscriptionDueDate } = req.body;

    try {
      const updatedStore = await prisma.store.update({
        where: { id },
        data: {
          activeDelivery,
          activeTotem,
          activeKds,
          activeFiscal,
          monthlyFee,
          subscriptionStatus,
          subscriptionDueDate: subscriptionDueDate ? new Date(subscriptionDueDate) : null
        }
      });

      return res.json({ success: true, store: updatedStore });
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao atualizar módulos da loja.' });
    }
  }
};

module.exports = MasterAdminController;