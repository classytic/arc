import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { defineResource, BaseController, createMongooseAdapter, allowPublic } from '@classytic/arc';

const OrderSchema = new mongoose.Schema(
  { item: String, total: Number },
  { timestamps: true },
);
const OrderModel = mongoose.model('ConsumerOrder', OrderSchema);
const orderRepo = new Repository(OrderModel);

// No audit flag — should NOT be audited in perResource mode
export default defineResource({
  name: 'order',
  adapter: createMongooseAdapter({ model: OrderModel, repository: orderRepo }),
  controller: new BaseController(orderRepo, { resourceName: 'order' }),
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: allowPublic(),
    update: allowPublic(),
    delete: allowPublic(),
  },
});
