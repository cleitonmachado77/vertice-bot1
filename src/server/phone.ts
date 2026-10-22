/** Normaliza e compara telefones BR (com/sem +, DDI 55 e 9º dígito). */

export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Chaves possíveis para o mesmo número (ordem: mais específica primeiro). */
export function phoneMatchKeys(value: string): string[] {
  const digits = phoneDigits(value);
  if (!digits) return [];
  const keys = new Set<string>([digits]);

  let national = digits;
  if (national.startsWith('55') && national.length >= 12) national = national.slice(2);

  if (national.length === 11 && national[2] === '9') {
    const withoutNine = national.slice(0, 2) + national.slice(3);
    keys.add(national);
    keys.add(withoutNine);
    keys.add(`55${national}`);
    keys.add(`55${withoutNine}`);
    keys.add(national.slice(-9));
    keys.add(withoutNine.slice(-8));
  } else if (national.length === 10) {
    const withNine = national.slice(0, 2) + '9' + national.slice(2);
    keys.add(national);
    keys.add(withNine);
    keys.add(`55${national}`);
    keys.add(`55${withNine}`);
    keys.add(national.slice(-8));
    keys.add(withNine.slice(-9));
  } else {
    keys.add(national);
    keys.add(digits.slice(-11));
    keys.add(digits.slice(-10));
    keys.add(digits.slice(-8));
  }

  return [...keys].filter(Boolean);
}

export function phonesMatch(a: string, b: string): boolean {
  const left = new Set(phoneMatchKeys(a));
  return phoneMatchKeys(b).some((key) => left.has(key));
}

export function looksLikePhoneName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/\p{L}/u.test(trimmed)) return false;
  const digits = phoneDigits(trimmed);
  return digits.length >= 8 && digits.length >= trimmed.replace(/\s/g, '').length * 0.7;
}

/** Normaliza WhatsApp BR para dígitos com DDI 55 (ex.: 5511999998888). */
export function normalizeWhatsappPhone(value: string): string {
  const digits = phoneDigits(value);
  if (!digits) return '';
  if (digits.length < 10) throw new Error('Informe um WhatsApp válido com DDD');
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.length >= 12) return digits;
  throw new Error('Informe um WhatsApp válido com DDD');
}
