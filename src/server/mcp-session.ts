import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ConnectionPool } from "./connection-pool";

/** Only used for the application's allowlisted, read-only MCP operations. */
export async function readMcpSession<T>(
  pool: ConnectionPool<Client>,
  request: (client: Client) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let expired = false;
    try {
      return await pool.use(async (client) => {
        signal?.throwIfAborted();
        const transport = client.transport;
        const session =
          transport instanceof StreamableHTTPClientTransport &&
          transport.sessionId;
        try {
          return await request(client);
        } catch (error) {
          // Stateful Streamable HTTP uses 404 for an expired session. A plain
          // endpoint 404, JSON-RPC error, SSE failure or auth error is not this case.
          if (
            session &&
            error instanceof StreamableHTTPError &&
            error.code === 404
          ) {
            expired = true;
            pool.invalidate(client);
          }
          throw error;
        }
      });
    } catch (error) {
      if (!expired || attempt >= 1 || signal?.aborted) throw error;
    }
  }
}
