import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const centralClient = 'src/worker/infrastructure/gateway-inference-client.ts';
const root = path.resolve(import.meta.dirname, '../..');
const pattern = /(?:\benv\.AI\.(?:run|gateway)\b|#ai\.(?:run|gateway)\b|\baiGatewayLogId\b)/u;

function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
}

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(absolute)));
    else if (/\.ts$/u.test(entry.name)) found.push(path.relative(root, absolute));
  }
  return found;
}

describe('AI Gateway isolation', () => {
  it('allows only the central gateway client to use Workers AI', async () => {
    const offenders: string[] = [];
    for (const file of await sources(path.join(root, 'src/worker'))) {
      if (file === centralClient) continue;
      if (pattern.test(withoutComments(await readFile(path.join(root, file), 'utf8'))))
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
