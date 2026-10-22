/** Caractere de substituição (U+FFFD) — sinal de nome importado com encoding errado. */
const REPLACEMENT_CHAR_RE = /\uFFFD/g;

/**
 * Chave de deduplicação de parceiros: sem acento, sem U+FFFD, minúscula,
 * espaços colapsados. “Lupionópolis” e “Lupionopolis” viram a mesma chave.
 */
export function partnerNameKey(value: string): string {
  return String(value || '')
    .replace(REPLACEMENT_CHAR_RE, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasCorruptedEncoding(value: string): boolean {
  return /\uFFFD/.test(String(value || ''));
}

/**
 * “Associa��o do Desenvolvimento Comunit�rio” → procura entre `candidates` um nome
 * íntegro em que cada U+FFFD corresponde a exatamente um caractere.
 * Sem gêmeo, devolve o nome original.
 */
export function repairCorruptedName(name: string, candidates: string[]): string {
  if (!hasCorruptedEncoding(name)) return name;
  const escaped = name
    .split('\uFFFD')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.');
  const pattern = new RegExp(`^${escaped}$`, 'iu');
  const twin = candidates.find(
    (candidate) => candidate !== name && !hasCorruptedEncoding(candidate) && pattern.test(candidate),
  );
  return twin || name;
}
