import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Shared customer identifier validation used by both tool input schemas.
const customerIdSchema = z
  .string()
  .regex(/^CUST-\d{5}$/, "customer_id must match CUST-XXXXX");

// Strict schemas reject missing, malformed, and unexpected input fields.
const customerRecordInput = z
  .object({
    customer_id: customerIdSchema,
  })
  .strict();

const refundInput = z
  .object({
    customer_id: customerIdSchema,
    amount: z.number().finite("amount must be a finite number").positive("amount must be greater than zero"),
    reason: z.string().min(10, "reason must be at least 10 characters"),
  })
  .strict();

type CustomerRecord = {
  customer_id: string;
  status: "active";
  name: string;
  refunds: RefundRecord[];
};

type RefundRecord = {
  refund_id: string;
  amount: number;
  reason: string;
  status: "refund_requested";
};

// In-memory sample data keeps the server runnable without an external database.
const customers = new Map<string, CustomerRecord>([
  [
    "CUST-12345",
    {
      customer_id: "CUST-12345",
      status: "active",
      name: "Example Customer",
      refunds: [],
    },
  ],
]);
let nextRefundId = 1;

// Use the public MCP server facade and its protocol layer for custom handlers.
const server = new McpServer(
  {
    name: "custom-customer-server",
    version: "1.0.0",
  },
  { capabilities: { tools: {} } },
);

// Advertise the tools and their JSON schemas to MCP clients.
server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_customer_record",
      description: "Retrieve a customer record by its customer identifier.",
      inputSchema: {
        type: "object",
        properties: {
          customer_id: { type: "string", pattern: "^CUST-\\d{5}$" },
        },
        required: ["customer_id"],
        additionalProperties: false,
      },
    },
    {
      name: "trigger_refund",
      description: "Create a refund request for a customer.",
      inputSchema: {
        type: "object",
        properties: {
          customer_id: { type: "string", pattern: "^CUST-\\d{5}$" },
          amount: { type: "number", exclusiveMinimum: 0 },
          reason: { type: "string", minLength: 10 },
        },
        required: ["customer_id", "amount", "reason"],
        additionalProperties: false,
      },
    },
  ],
}));

// Validate and execute each tool request while keeping diagnostics off stdout.
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_customer_record") {
    // Parse before logging or accessing storage so invalid input has no side effects.
    const parsed = customerRecordInput.safeParse(args);
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, parsed.error.message);
    }

    process.stderr.write(`get_customer_record requested for ${parsed.data.customer_id}\n`);
    // A missing record is a protocol-level invalid-parameter error, not a fake response.
    const customer = customers.get(parsed.data.customer_id);
    if (!customer) {
      throw new McpError(ErrorCode.InvalidParams, `Customer not found: ${parsed.data.customer_id}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(customer),
        },
      ],
    };
  }

  if (name === "trigger_refund") {
    // Validate all fields together, including strict rejection of extra properties.
    const parsed = refundInput.safeParse(args);
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, parsed.error.message);
    }

    process.stderr.write(`trigger_refund requested for ${parsed.data.customer_id}\n`);
    // Check the customer before allocating an ID or mutating the in-memory record.
    const customer = customers.get(parsed.data.customer_id);
    if (!customer) {
      throw new McpError(ErrorCode.InvalidParams, `Customer not found: ${parsed.data.customer_id}`);
    }

    // IDs are deterministic within one process, which keeps the example easy to test.
    const refund: RefundRecord = {
      refund_id: `REF-${String(nextRefundId++).padStart(5, "0")}`,
      amount: parsed.data.amount,
      reason: parsed.data.reason,
      status: "refund_requested",
    };
    customer.refunds.push(refund);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            customer_id: parsed.data.customer_id,
            ...refund,
          }),
        },
      ],
    };
  }

  throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
});

// Attach the MCP server to stdio; stdout remains reserved for JSON-RPC traffic.
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.server.connect(transport);
  process.stderr.write("Custom MCP server running on stdio\n");
}

// Surface startup failures on stderr and return a failing process status.
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`MCP server failed to start: ${message}\n`);
  process.exitCode = 1;
});
