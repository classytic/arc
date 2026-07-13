# VDP Integration — Authentication, Encryption & Environments

## When to Read This

Read this reference when working on:
- Setting up or debugging authentication (X-Pay Token or Two-Way SSL)
- Implementing or troubleshooting Message Level Encryption (MLE/JWE)
- Configuring environment URLs (Sandbox, Certification, Production)
- Managing credentials, certificates, or key rotation
- Writing VDP integration code (connectivity, API calls)

## Code Examples & Starter Kit

Fetch **https://sandbox.mcp.visa.com/mcp/doc/llms.txt** for all code examples, implementation references, and direct links to source code. This covers MCP client integration, direct API client, VDP connectivity, authentication implementations and payload builders.

## Official Documentation

| Resource | URL |
|----------|-----|
| Developer Center | https://developer.visa.com |
| Quick Start Guide | https://developer.visa.com/pages/working-with-visa-apis/visa-developer-quick-start-guide |
| X-Pay Token Guide | https://developer.visa.com/pages/working-with-visa-apis/x-pay-token |
| Two-Way SSL Guide | https://developer.visa.com/pages/working-with-visa-apis/two-way-ssl |
| MLE / Encryption Guide | https://developer.visa.com/pages/encryption_guide |

## Authentication

VDP supports two authentication methods.

### X-Pay Token (HMAC-SHA256)

Preferred for most integrations. The token is computed over the request and included as a header.

See [X-Pay Token Guide](https://developer.visa.com/pages/working-with-visa-apis/x-pay-token) and llms.txt for implementation code.

### Two-Way SSL (Mutual TLS)

Certificate-based mutual authentication. Required by some APIs or for higher-security environments.

See [Two-Way SSL Guide](https://developer.visa.com/pages/working-with-visa-apis/two-way-ssl) and llms.txt for implementation code.

### Key Gotcha — Resource Path Differs for VIC APIs

| Product Type | Resource Path for X-Pay Token |
|--------------|-------------------------------|
| Standard APIs | Full path after domain (e.g., `/vdp/helloworld`) |
| VIC APIs | Path **excluding** context prefix (e.g., `/vic/v1/...` becomes `/v1/...`) |

## Message Level Encryption (MLE)

MLE provides end-to-end payload encryption using JWE. See the [Encryption Guide](https://developer.visa.com/pages/encryption_guide) and llms.txt for implementation code.

- Check each API's enforcement level (Mandatory / Optional / Not Applicable) in the API docs or VDP Dashboard.
- MLE requires two certificate pairs: Visa's server key (for encrypting requests) and your client key (for encrypting responses).

**Key gotchas:**

| Issue | Detail |
|-------|--------|
| `keyId` header required | Include `keyId` as an HTTP header in all MLE-enabled API calls |
| Key-ID limit | Up to 3 active Key-IDs per project (for rotation) |
| Key-ID changes on renewal | Key-ID changes when certificates are renewed — update your config |
| CSR UID field | CSR must include the Key-ID as the UID field |

## Environments

| Environment | B2B URL | B2C URL |
|-------------|---------|---------|
| Sandbox | `https://sandbox.api.visa.com/` | `https://sandbox.webapi.visa.com/` |
| Certification | `https://cert.api.visa.com/` | - |
| Production | `https://api.visa.com/` | - |

**Progression**: Always develop in Sandbox → test in Certification → deploy to Production.

## Credential Management Best Practices

- Monitor certificate expiration dates in VDP Dashboard — renew before expiry
- New certificates require new Key-IDs for MLE
- Maintain 2-3 active credential sets for seamless rotation
- Always test credential rotation in Sandbox/Certification before Production
- Revoke old credentials only after successful migration
- Store credentials securely (environment variables or secrets manager, never in source code)
