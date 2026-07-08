const UNITS = ['', 'unu', 'doi', 'trei', 'patru', 'cinci', 'șase', 'șapte', 'opt', 'nouă'];
const UNITS_FEM = ['', 'una', 'două', 'trei', 'patru', 'cinci', 'șase', 'șapte', 'opt', 'nouă'];
const TEENS = [
  'zece', 'unsprezece', 'doisprezece', 'treisprezece', 'paisprezece',
  'cincisprezece', 'șaisprezece', 'șaptesprezece', 'optsprezece', 'nouăsprezece',
];
const TENS = ['', '', 'douăzeci', 'treizeci', 'patruzeci', 'cincizeci', 'șaizeci', 'șaptezeci', 'optzeci', 'nouăzeci'];

function belowHundred(n: number, fem = false): string {
  const units = fem ? UNITS_FEM : UNITS;
  if (n < 10) return units[n];
  if (n < 20) return TEENS[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? TENS[t] : `${TENS[t]} și ${units[u]}`;
}

function belowThousand(n: number, fem = false): string {
  if (n < 100) return belowHundred(n, fem);
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const hundreds = h === 1 ? 'o sută' : h === 2 ? 'două sute' : `${UNITS_FEM[h]} sute`;
  return rest === 0 ? hundreds : `${hundreds} ${belowHundred(rest, fem)}`;
}

/** Integer → Romanian words, for contract "price in words" clauses. */
export function numberToRoWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const parts: string[] = [];

  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;

  if (millions > 0) {
    if (millions === 1) parts.push('un milion');
    else parts.push(`${belowThousand(millions, true)} ${millions < 20 ? 'milioane' : 'de milioane'}`);
  }
  if (thousands > 0) {
    if (thousands === 1) parts.push('o mie');
    else parts.push(`${belowThousand(thousands, true)} ${thousands < 20 ? 'mii' : 'de mii'}`);
  }
  if (rest > 0) parts.push(belowThousand(rest));

  return parts.join(' ');
}

export function amountInWords(amount: number, currency: string): string {
  const whole = Math.floor(amount);
  const cents = Math.round((amount - whole) * 100);
  const currencyWord = currency === 'RON' ? 'lei' : currency === 'EUR' ? 'euro' : currency;
  const centsWord = currency === 'RON' ? 'bani' : 'cenți';
  let out = `${numberToRoWords(whole)} ${currencyWord}`;
  if (cents > 0) out += ` și ${numberToRoWords(cents)} ${centsWord}`;
  return out;
}
