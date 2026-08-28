// Resolve the MCP client from the server's install first. CI intentionally
// installs only server/package.json; the fallback keeps `npm test` convenient
// for consumers who install the published root package instead.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function from(packageJson) {
  const require = createRequire(packageJson);
  return {
    client: require.resolve('@modelcontextprotocol/sdk/client/index.js'),
    stdio: require.resolve('@modelcontextprotocol/sdk/client/stdio.js')
  };
}

let resolved;
try {
  resolved = from(new URL('../server/package.json', import.meta.url));
} catch {
  resolved = from(new URL('../package.json', import.meta.url));
}

const client = await import(pathToFileURL(resolved.client).href);
const stdio = await import(pathToFileURL(resolved.stdio).href);

export const { Client } = client;
export const { StdioClientTransport } = stdio;
