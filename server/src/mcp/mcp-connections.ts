import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

export type McpToolSummary = {
  name: string;
  description: string | null;
  inputSchema: unknown;
};

export type McpConnection = {
  id: string;
  endpoint: string;
  server: { name: string | null; version: string | null };
  tools: McpToolSummary[];
  createdAt: string;
  updatedAt: string;
};

type McpSdkClient = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: McpToolSummary[] }>;
  getServerVersion(): { name?: string; version?: string } | undefined;
  close(): Promise<void>;
};

export class McpConnectionError extends Error {
  constructor(public readonly code: 'invalid_input' | 'connection_failed', message: string) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isBlockedIpv4(normalized.slice(7));
  return normalized === '::' || normalized === '::1'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb');
}

async function validateEndpoint(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new McpConnectionError('invalid_input', 'Введите корректный HTTPS endpoint.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new McpConnectionError('invalid_input', 'MCP endpoint должен быть публичным HTTPS URL без userinfo и fragment.');
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new McpConnectionError('invalid_input', 'MCP endpoint не должен указывать на локальную или приватную сеть.');
  }
  return url;
}

function requestHeaders(headerName?: string, headerValue?: string): Record<string, string> {
  const name = headerName?.trim() ?? '';
  const value = headerValue?.trim() ?? '';
  if ((name === '') !== (value === '')) {
    throw new McpConnectionError('invalid_input', 'Укажите Header name и Header value вместе или оставьте оба поля пустыми.');
  }
  if (!name) return {};
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
    throw new McpConnectionError('invalid_input', 'Некорректный HTTP header.');
  }
  const reserved = new Set(['host', 'content-length', 'connection', 'mcp-session-id', 'mcp-protocol-version']);
  if (reserved.has(name.toLowerCase())) {
    throw new McpConnectionError('invalid_input', 'Этот HTTP header управляется MCP-клиентом и не может быть задан вручную.');
  }
  return { [name]: value };
}

async function safeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, { ...init, redirect: 'manual' });
  await validateEndpoint(request.url);
  const response = await fetch(request);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new McpConnectionError('connection_failed', 'MCP server redirects are not supported.');
  }
  return response;
}

export async function discoverMcpConnection(input: {
  endpoint: string;
  headerName?: string;
  headerValue?: string;
}): Promise<Omit<McpConnection, 'id' | 'createdAt' | 'updatedAt'>> {
  const endpoint = await validateEndpoint(input.endpoint);
  const headers = requestHeaders(input.headerName, input.headerValue);
  const packageName: string = '@modelcontextprotocol/client';
  let client: McpSdkClient | undefined;

  try {
    const sdk = await import(packageName) as {
      Client: new (info: { name: string; version: string }) => McpSdkClient;
      StreamableHTTPClientTransport: new (url: URL, options: { requestInit: RequestInit; fetch: typeof fetch }) => unknown;
    };
    client = new sdk.Client({ name: 'web-assistant-mcp-discovery', version: '1.0.0' });
    const transport = new sdk.StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers, redirect: 'manual' },
      fetch: safeFetch,
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const serverInfo = client.getServerVersion();
    return {
      endpoint: endpoint.toString(),
      server: {
        name: serverInfo?.name?.trim() || endpoint.hostname,
        version: serverInfo?.version?.trim() || null,
      },
      tools: tools.map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === 'string' ? tool.description : null,
        inputSchema: tool.inputSchema,
      })),
    };
  } catch (error) {
    if (error instanceof McpConnectionError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND') {
      throw new McpConnectionError('connection_failed', 'MCP SDK не установлен. Выполните npm install @modelcontextprotocol/client --workspace server.');
    }
    throw new McpConnectionError('connection_failed', error instanceof Error ? error.message : 'Не удалось подключиться к MCP server.');
  } finally {
    await client?.close().catch(() => undefined);
  }
}

export class JsonMcpConnectionStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<McpConnection[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as { connections?: McpConnection[] };
      return Array.isArray(parsed.connections) ? parsed.connections : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(discovered: Omit<McpConnection, 'id' | 'createdAt' | 'updatedAt'>): Promise<McpConnection> {
    const connections = await this.list();
    const existing = connections.find((item) => item.endpoint === discovered.endpoint);
    const now = new Date().toISOString();
    const connection: McpConnection = {
      ...discovered,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.write([connection, ...connections.filter((item) => item.id !== connection.id)]);
    return connection;
  }

  async remove(id: string): Promise<boolean> {
    const connections = await this.list();
    const next = connections.filter((item) => item.id !== id);
    if (next.length === connections.length) return false;
    await this.write(next);
    return true;
  }

  private async write(connections: McpConnection[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ connections }, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}
