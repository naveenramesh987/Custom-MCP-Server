import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";

// Start the compiled server and parse newline-delimited JSON-RPC responses.
function startServer() {
  const child = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  const messages = [];

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    // Responses may be split across chunks, so retain an incomplete final line.
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      messages.push(JSON.parse(line));
    }
  });

  return {
    child,
    messages,
    get stderr() {
      return stderr;
    },
    async request(id, method, params = {}) {
      // Send one newline-delimited JSON-RPC request and wait for its matching ID.
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      while (!messages.some((message) => message.id === id)) {
        await once(child.stdout, "data");
      }
      return messages.find((message) => message.id === id);
    },
    async stop() {
      // Every test owns and terminates its server process.
      child.kill();
      await once(child, "close");
    },
  };
}

// Complete the MCP handshake before running tool-level assertions.
async function initializedServer() {
  const server = startServer();
  const response = await server.request(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  assert.equal(response.result.serverInfo.name, "custom-customer-server");
  server.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );
  return server;
}

// Verify both tools are advertised through the MCP discovery endpoint.
test("lists both customer tools", async () => {
  const server = await initializedServer();
  try {
    const response = await server.request(2, "tools/list");
    assert.deepEqual(
      response.result.tools.map((tool) => tool.name),
      ["get_customer_record", "trigger_refund"],
    );
  } finally {
    await server.stop();
  }
});

// Verify a valid customer lookup returns structured JSON content.
test("returns a customer record for valid input", async () => {
  const server = await initializedServer();
  try {
    const response = await server.request(2, "tools/call", {
      name: "get_customer_record",
      arguments: { customer_id: "CUST-12345" },
    });
    assert.equal(response.result.isError, undefined);
    const customer = JSON.parse(response.result.content[0].text);
    assert.equal(customer.customer_id, "CUST-12345");
    assert.deepEqual(customer.refunds, []);
  } finally {
    await server.stop();
  }
});

// Verify refunds are created and persisted for subsequent lookups.
test("stores a valid refund on the customer record", async () => {
  const server = await initializedServer();
  try {
    const refundResponse = await server.request(2, "tools/call", {
      name: "trigger_refund",
      arguments: {
        customer_id: "CUST-12345",
        amount: 25.5,
        reason: "Customer requested a return",
      },
    });
    const refund = JSON.parse(refundResponse.result.content[0].text);
    assert.equal(refund.refund_id, "REF-00001");
    assert.equal(refund.status, "refund_requested");

    const customerResponse = await server.request(3, "tools/call", {
      name: "get_customer_record",
      arguments: { customer_id: "CUST-12345" },
    });
    const customer = JSON.parse(customerResponse.result.content[0].text);
    assert.deepEqual(customer.refunds, [
      {
        refund_id: "REF-00001",
        amount: 25.5,
        reason: "Customer requested a return",
        status: "refund_requested",
      },
    ]);
  } finally {
    await server.stop();
  }
});

// Verify malformed arguments use the standard JSON-RPC InvalidParams code.
test("rejects malformed tool arguments with InvalidParams", async () => {
  const server = await initializedServer();
  try {
    const response = await server.request(2, "tools/call", {
      name: "trigger_refund",
      arguments: {
        customer_id: "CUST-1",
        amount: 0,
        reason: "too short",
      },
    });
    assert.equal(response.error.code, -32602);
  } finally {
    await server.stop();
  }
});

// Verify protocol messages stay on stdout while diagnostics stay on stderr.
test("keeps stdout as JSON-RPC and writes diagnostics to stderr", async () => {
  const server = await initializedServer();
  try {
    await server.request(2, "tools/call", {
      name: "get_customer_record",
      arguments: { customer_id: "CUST-12345" },
    });
    assert.ok(server.messages.every((message) => message.jsonrpc === "2.0"));
    assert.match(server.stderr, /Custom MCP server running on stdio/);
  } finally {
    await server.stop();
  }
});
