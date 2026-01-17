/**
 * Arc CLI - Introspect Command
 *
 * Shows all registered resources and their configuration
 */

import type { RegistryEntry } from '../../types/index.js';

export async function introspect(args: string[]): Promise<void> {
  console.log('Introspecting Arc resources...\n');

  try {
    // Import the resource registry
    const { resourceRegistry } = await import('../../registry/index.js');

    const resources: RegistryEntry[] = resourceRegistry.getAll();

    if (resources.length === 0) {
      console.log('⚠️  No resources registered.');
      console.log('\nTo introspect resources, you need to load them first:');
      console.log('  arc introspect --entry ./index.js');
      console.log('\nWhere index.js imports all your resource definitions.');
      return;
    }

    console.log(`Found ${resources.length} resource(s):\n`);

    resources.forEach((resource, index) => {
      console.log(`${index + 1}. ${resource.name}`);
      console.log(`   Display Name: ${resource.displayName}`);
      console.log(`   Prefix: ${resource.prefix}`);
      console.log(`   Module: ${resource.module || 'none'}`);

      if (resource.permissions) {
        console.log(`   Permissions:`);
        Object.entries(resource.permissions).forEach(([op, roles]) => {
          console.log(`     ${op}: [${(roles as string[]).join(', ')}]`);
        });
      }

      if (resource.presets && resource.presets.length > 0) {
        console.log(`   Presets: ${resource.presets.join(', ')}`);
      }

      if (resource.additionalRoutes && resource.additionalRoutes.length > 0) {
        console.log(`   Additional Routes: ${resource.additionalRoutes.length}`);
      }

      console.log('');
    });

    // Summary
    const stats = resourceRegistry.getStats();
    console.log('Summary:');
    console.log(`  Total Resources: ${stats.totalResources}`);
    console.log(`  With Presets: ${resources.filter((r) => r.presets?.length > 0).length}`);
    console.log(
      `  With Custom Routes: ${resources.filter((r) => r.additionalRoutes && r.additionalRoutes.length > 0).length}`
    );
  } catch (error: any) {
    console.error('Error:', error.message);
    console.log('\nTip: Run this command after starting your application.');
    process.exit(1);
  }
}

export default introspect;
