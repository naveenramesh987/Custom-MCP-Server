# Custom-MCP-Server

A TypeScript MCP server exposing two strictly validated tools over stdio:

- `get_customer_record`: accepts `customer_id` values matching `CUST-XXXXX`.
- `trigger_refund`: accepts a matching `customer_id`, a finite positive `amount`,
  and a `reason` with at least 10 characters.

The sample server keeps customer records and refund requests in memory for the
life of the process. The seeded customer is `CUST-12345`; restarting the server
resets its data.

## Run

Requires Node.js 18 or newer.

```bash
npm install
npm run build
npm start
```

The server uses the official `@modelcontextprotocol/sdk` stdio transport.
Standard output is reserved for MCP JSON-RPC messages; startup, request, and
fatal-error diagnostics are written to standard error only. Invalid tool
arguments are rejected by strict Zod schemas and returned as the standard
JSON-RPC `-32602` (`InvalidParams`) error rather than reaching a tool handler.