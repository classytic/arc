# Visa Intelligent Commerce (VIC) Integration Guide

## When to Read This

Read this reference when building or debugging:
- Card enrollment and tokenization via VIC
- Purchase instruction creation, updates, or cancellation
- Payment credential retrieval
- Transaction signal reporting
- Agent onboarding with Visa

For authentication/MLE setup, see [vdp-integration.md](vdp-integration.md).

## Code Examples

Fetch **https://sandbox.mcp.visa.com/mcp/doc/llms.txt** for all VIC code examples, MCP client integration, tool/workflow definitions, and payload builders.

## Overview

VIC enables AI agents to facilitate secure commerce on behalf of consumers. It combines five integrated services:

| Service | Purpose |
|---------|---------|
| **Tokenization** | Replace PANs with secure tokens for payment processing |
| **Authentication** | Verify cardholder identity via step-up challenges and Passkeys |
| **Payment Instructions** | Define how, when, and where payments should be made |
| **Signals** | Confirm transaction events and update merchant status |
| **Personalization** | Access cardholder preferences via Visa Data Tokens |

## API Groups

| API Group | Capabilities | Documentation |
|-----------|--------------|---------------|
| **VTS (Visa Token Service)** | Tokenization, Card Enrollment, Authentication | https://developer.visa.com/capabilities/vts |
| **VIC APIs** | Purchase Instructions, Payment Credentials, Signals | https://developer.visa.com/capabilities/visa-intelligent-commerce |
| **Visa Data Tokens** | Cardholder Personalization Data | https://developer.visa.com/capabilities/visa-data-tokens |

## Integration Approaches

Choose based on your architecture:

- **MCP-Based**: StreamableHTTP transport for AI agent systems using Model Context Protocol.
- **Direct API**: REST calls with X-Pay auth and MLE encryption for traditional backend services.
- **VDP**: Hello World API for initial connectivity verification before starting VIC integration.

## Core Workflows

Key workflows (all implementations available via llms.txt):

- **Agent Onboarding** — Register agent with Visa, configure credentials, verify connectivity
- **Card Enrollment** — Enroll payment card with step-up verification and optional Passkey setup
- **Purchase Instructions** — Create, update, or cancel standing payment instructions with cardholder authentication
- **Payment Credentials** — Retrieve tokenized payment data after validating against instruction parameters
- **Transaction Signals** — Report transaction outcomes (completed, failed, delivery confirmed) to Visa

## VIC-Specific Notes

- VIC APIs use a different resource path format for X-Pay Token computation — see [vdp-integration.md](vdp-integration.md) Authentication section
- VIC requires MLE for most operations — check enforcement level per endpoint in VDP Dashboard
- VIC MCP tools handle auth and MLE automatically when using the MCP integration path
