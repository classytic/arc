import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { defineResource, BaseController, allowPublic } from '@classytic/arc';

const ProductSchema = new mongoose.Schema(
  { name: String, price: Number },
  { timestamps: true },
);
const ProductModel = mongoose.model('ConsumerProduct', ProductSchema);
const productRepo = new Repository(ProductModel);

export default defineResource({
  name: 'product',
  audit: true, // per-resource opt-in
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  controller: new BaseController(productRepo, { resourceName: 'product' }),
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: allowPublic(),
    update: allowPublic(),
    delete: allowPublic(),
  },
});
