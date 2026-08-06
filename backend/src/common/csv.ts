/**
 * Minimal dependency-free CSV parser tailored for the catalogue imports
 * (parteneri / articole / gestiuni). Handles UTF-8 BOM, `,` / `;` / tab
 * delimiter auto-detection, quoted fields with escaped quotes and CRLF/LF.
 *
 * Returns one object per data row keyed by a canonical header. Spaces,
 * punctuation, underscores and Romanian diacritics are ignored, so exports
 * such as `Cod fiscal`, `Cod_fiscal` and `COD-FISCAL` map identically.
 */
export function parseCsv(input: string | Buffer): Record<string, string>[] {
  let text = decodeTabularText(input)
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
  const declaredSeparator = text.match(/^\s*sep=(.)\s*[\r\n]+/i);
  const delimiter = declaredSeparator?.[1] ?? detectDelimiter(text);
  if (declaredSeparator) text = text.slice(declaredSeparator[0].length);
  if (!text.trim()) return [];

  const rows = tokenize(text, delimiter).filter(
    (row) => row.length > 0 && !(row.length === 1 && row[0].trim() === ''),
  );
  if (rows.length === 0) return [];

  const headers = rows[0].map(normalizeCsvHeader);
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!header) return;
      record[header] = (row[index] ?? '').trim();
    });
    return record;
  });
}

function decodeTabularText(input: string | Buffer): string {
  if (typeof input === 'string') return input;
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    return input.subarray(2).toString('utf16le');
  }
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(input.length - 2);
    for (let index = 2; index + 1 < input.length; index += 2) {
      swapped[index - 2] = input[index + 1];
      swapped[index - 1] = input[index];
    }
    return swapped.toString('utf16le');
  }
  const sampleLength = Math.min(input.length, 2048);
  let oddNulls = 0;
  for (let index = 1; index < sampleLength; index += 2) {
    if (input[index] === 0) oddNulls += 1;
  }
  if (sampleLength > 8 && oddNulls > sampleLength / 8) {
    return input.toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return new TextDecoder('windows-1250').decode(input);
  }
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const candidates: Array<[string, number]> = [
    [';', (firstLine.match(/;/g) ?? []).length],
    [',', (firstLine.match(/,/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ',';
}

function tokenize(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else if (char === '\r') {
      // handled together with the following \n (or as a standalone CR)
      if (text[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        field = '';
        row = [];
      }
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Reads the first non-empty value among the given candidate header names
 * (already lower-cased in the parsed record).
 */
export function pick(row: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = row[normalizeCsvHeader(name)];
    if (value != null && value.trim() !== '') return value.trim();
  }
  return undefined;
}

export function normalizeCsvHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
