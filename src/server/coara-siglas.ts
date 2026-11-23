import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type CoaraSiglaEntry = {
  name: string;
  key: string;
  sigla: string;
};

/** Chave de match produto↔abreviacao Coara (sem acento, só A-Z0-9 e espaços). */
export function productNameKey(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadCoaraSiglaMap(
  filePath = defaultSeedPath(),
): Map<string, CoaraSiglaEntry> {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as CoaraSiglaEntry[];
  const map = new Map<string, CoaraSiglaEntry>();
  for (const entry of raw) {
    const key = entry.key || productNameKey(entry.name);
    if (!key || !entry.sigla) continue;
    map.set(key, { name: entry.name, key, sigla: String(entry.sigla).trim().toUpperCase() });
  }
  return map;
}

function defaultSeedPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'seeds', 'coara-product-siglas.json');
}
