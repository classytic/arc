import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { defineResource, BaseController, allowPublic } from '@classytic/arc';

const HookSchema = new mongoose.Schema({ event: String }, { timestamps: true });
const HookModel = mongoose.model('ConsumerHook', HookSchema);
const hookRepo = new Repository(HookModel);

// skipGlobalPrefix: registers at /hooks (not /api/v1/hooks)
export default defineResource({
  name: 'hook',
  prefix: '/hooks',
  skipGlobalPrefix: true,
  adapter: createMongooseAdapter({ model: HookModel, repository: hookRepo }),
  controller: new BaseController(hookRepo, { resourceName: 'hook' }),
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: allowPublic(),
    update: allowPublic(),
    delete: allowPublic(),
  },
});
