import { describe, it, expect } from "vitest";
import {
  ArcDynamicLoader,
  type ArcArchitectureSchema,
} from "../../src/dynamic/ArcDynamicLoader.js";
import type { PermissionCheck } from "../../src/permissions/types.js";

describe("ArcDynamicLoader (Dynamic / AAS)", () => {
  it("should parse an AAS schema and dynamically map it to Arc resources", () => {
    // 1. Mock adapter resolver
    const resolvedAdapters: string[] = [];

    // 2. Instantiate the loader with context
    const loader = new ArcDynamicLoader({
      adapterResolver: (resourceName, pattern) => {
        resolvedAdapters.push(resourceName);
        return {
          // Dummy adapter
          repository: {
            getAll: async () => ({
              docs: [],
              total: 0,
              limit: 10,
              page: 1,
              pages: 1,
            }),
            getById: async () => null,
            getOne: async () => null,
            create: async () => ({}),
            update: async () => ({}),
            delete: async () => true,
          },
        };
      },
    });

    // 3. Define the AI JSON representation (AAS)
    const aas: ArcArchitectureSchema = {
      app: "test-app",
      resources: [
        {
          name: "campaign",
          adapterPattern: "postgres",
          permissions: "adminOnly",
          presets: ["softDelete"],
        },
        {
          name: "project",
          permissions: {
            list: "public",
            get: "public",
            create: "admin",
            update: "owner",
            delete: "admin",
          },
        },
      ],
    };

    // 4. Load the schema into Resource Definitions
    const definitions = loader.load(aas);

    // 5. Assertions
    expect(definitions.length).toBe(2);
    expect(resolvedAdapters).toEqual(["campaign", "project"]);

    // Verify first resource
    const campaign = definitions[0];
    expect(campaign.name).toBe("campaign");
    expect(campaign._appliedPresets).toContain("softDelete");

    // Verify fallback generic 'adminOnly' mapping applied
    const campaignPerms: any = campaign.permissions;
    expect(campaignPerms.list).toBeDefined();

    // Verify fine-grained mapping on second resource
    const project = definitions[1];
    expect(project.name).toBe("project");
    const projectPerms: any = project.permissions;
    expect(projectPerms.list).toBeDefined(); // mapped to publicRead().list
    expect(projectPerms.update).toBeDefined(); // mapped to ownerWithAdminBypass().update
  });
});
