/**
 * Minimal MCP client over Streamable HTTP.
 *
 * Connects `nah` to a nah-cloud MCP server (or any MCP server speaking the
 * Streamable HTTP transport). Auth is a bearer token supplied by the caller —
 * for nah-cloud that token lives in the device credential store under kind
 * "cloud" and is resolved by the caller before constructing the client.
 *
 * The client holds one session: `initialize` returns a `Mcp-Session-Id` which
 * is echoed on every later call. Tool results come back as structured content
 * that the caller renders — for `nah` that means as transcript lines exactly
 * like local tool calls.
 */

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolResult = {
  structuredContent?: unknown;
  text?: string;
};

export class McpClient {
  private readonly baseUrl: string;
  private readonly token: () => string | undefined;
  private sessionId?: string;
  private initialized = false;

  constructor(options: { baseUrl: string; token: () => string | undefined }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
  }

  /** Whether `initialize` has completed for this session. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** The session id established by `initialize`, if any. */
  get session(): string | undefined {
    return this.sessionId;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    const token = this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async post<T>(body: unknown): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`MCP ${response.status} for ${this.baseUrl}: ${text || response.statusText}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Establish the MCP session and advertise capabilities.
   *
   * Must be called before `listTools` or `callTool`. Returns the negotiated
   * protocol version and server info. Captures the `Mcp-Session-Id` response
   * header so every later call echoes it back.
   */
  async initialize(): Promise<{
    protocolVersion: string;
    capabilities: Record<string, unknown>;
    serverInfo: { name: string; version?: string };
  }> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-14",
          capabilities: {},
          clientInfo: { name: "nah", version: "0.0.1" },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`MCP initialize ${response.status}: ${text || response.statusText}`);
    }

    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    const result = (await response.json()) as {
      jsonrpc: string;
      id: number | string | null;
      result: {
        protocolVersion: string;
        capabilities: Record<string, unknown>;
        serverInfo: { name: string; version?: string };
      };
      error?: { code: number; message: string; data?: unknown };
    };
    if (result.error) {
      throw new Error(`MCP initialize failed: ${result.error.message}`);
    }
    this.initialized = true;
    return result.result;
  }

  /** List the tools the server exposes. */
  async listTools(): Promise<McpTool[]> {
    const result = await this.post<{
      jsonrpc: string;
      id: number | string | null;
      result: { tools: McpTool[] };
      error?: { code: number; message: string };
    }>({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });

    if (result.error) {
      throw new Error(`MCP tools/list failed: ${result.error.message}`);
    }
    return result.result.tools;
  }

  /**
   * Call a tool and return its result.
   *
   * The result is the MCP `CallToolResult`: `structuredContent` when the tool
   * returns data, `text` for a human-readable summary.
   */
  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.post<{
      jsonrpc: string;
      id: number | string | null;
      result: McpToolResult;
      error?: { code: number; message: string; data?: unknown };
    }>({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    });

    if (result.error) {
      throw new Error(`MCP ${name} failed: ${result.error.message}`);
    }
    return result.result;
  }
}
