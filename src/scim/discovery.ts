/**
 * SCIM 2.0 discovery endpoints (RFC 7644 §4)
 *
 * Three endpoints every IdP probes during connector setup:
 *   - `/ServiceProviderConfig` — capability advertisement
 *   - `/ResourceTypes`         — what's mounted (User / Group)
 *   - `/Schemas`               — schema discovery (minimal stub)
 *
 * Authentication enforced inline so connector probes that bypass auth
 * surface a clean 401 instead of a 200 with mismatched expectations.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { sendScimError } from "./helpers.js";
import type { ScimObservedEvent } from "./types.js";

type ObserveFn = (event: ScimObservedEvent) => void;

export function mountDiscoveryRoutes(
  fastify: FastifyInstance,
  prefix: string,
  hasGroups: boolean,
  authCheck: (request: FastifyRequest) => Promise<void>,
  maxResults: number,
  observe: ObserveFn,
): void {
  fastify.get(`${prefix}/ServiceProviderConfig`, async (request, reply) => {
    const start = Date.now();
    try {
      await authCheck(request);
      const baseUrl = `${request.protocol}://${request.hostname}${prefix}`;
      const payload = {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        documentationUri: "https://datatracker.ietf.org/doc/html/rfc7644",
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults },
        changePassword: { supported: false },
        sort: { supported: true },
        etag: { supported: false },
        authenticationSchemes: [
          {
            type: "oauthbearertoken",
            name: "OAuth Bearer Token",
            description: "Authentication via OAuth 2.0 bearer token",
            specUri: "https://datatracker.ietf.org/doc/html/rfc6750",
            primary: true,
          },
        ],
        meta: {
          location: `${baseUrl}/ServiceProviderConfig`,
          resourceType: "ServiceProviderConfig",
        },
      };
      observe({
        resourceType: "discovery",
        op: "discovery.serviceProviderConfig",
        status: 200,
        durationMs: Date.now() - start,
        path: "/ServiceProviderConfig",
      });
      return reply.code(200).header("Content-Type", "application/scim+json").send(payload);
    } catch (err) {
      observe({
        resourceType: "discovery",
        op: "discovery.serviceProviderConfig",
        status: 401,
        durationMs: Date.now() - start,
        path: "/ServiceProviderConfig",
      });
      return sendScimError(reply, err);
    }
  });

  fastify.get(`${prefix}/ResourceTypes`, async (request, reply) => {
    const start = Date.now();
    try {
      await authCheck(request);
      const baseUrl = `${request.protocol}://${request.hostname}${prefix}`;
      const types: Record<string, unknown>[] = [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          schema: "urn:ietf:params:scim:schemas:core:2.0:User",
          meta: { location: `${baseUrl}/ResourceTypes/User`, resourceType: "ResourceType" },
        },
      ];
      if (hasGroups) {
        types.push({
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "Group",
          name: "Group",
          endpoint: "/Groups",
          schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
          meta: { location: `${baseUrl}/ResourceTypes/Group`, resourceType: "ResourceType" },
        });
      }
      observe({
        resourceType: "discovery",
        op: "discovery.resourceTypes",
        status: 200,
        durationMs: Date.now() - start,
        path: "/ResourceTypes",
      });
      return reply
        .code(200)
        .header("Content-Type", "application/scim+json")
        .send({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
          totalResults: types.length,
          Resources: types,
        });
    } catch (err) {
      observe({
        resourceType: "discovery",
        op: "discovery.resourceTypes",
        status: 401,
        durationMs: Date.now() - start,
        path: "/ResourceTypes",
      });
      return sendScimError(reply, err);
    }
  });

  // Schemas endpoint — minimal stub. Most IdPs treat this as a sanity check.
  fastify.get(`${prefix}/Schemas`, async (request, reply) => {
    const start = Date.now();
    try {
      await authCheck(request);
      observe({
        resourceType: "discovery",
        op: "discovery.schemas",
        status: 200,
        durationMs: Date.now() - start,
        path: "/Schemas",
      });
      return reply
        .code(200)
        .header("Content-Type", "application/scim+json")
        .send({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
          totalResults: hasGroups ? 2 : 1,
          Resources: [
            { id: "urn:ietf:params:scim:schemas:core:2.0:User", name: "User" },
            ...(hasGroups
              ? [{ id: "urn:ietf:params:scim:schemas:core:2.0:Group", name: "Group" }]
              : []),
          ],
        });
    } catch (err) {
      observe({
        resourceType: "discovery",
        op: "discovery.schemas",
        status: 401,
        durationMs: Date.now() - start,
        path: "/Schemas",
      });
      return sendScimError(reply, err);
    }
  });
}
