import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuth } from 'google-auth-library';
import JSZip = require('jszip');

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const REQUIRED_COLUMNS = ['SERIE SASIU', 'MASA', 'LOCATIE'] as const;

interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
}

export interface DriveVehicleRow {
  vin: string;
  weightKg?: number;
  unloadingCity?: string;
  rowNumber: number;
}

export interface ParsedVehicleWorkbook {
  sheetName: string;
  rows: DriveVehicleRow[];
  duplicateVins: string[];
}

interface DriveWorkbookCache extends ParsedVehicleWorkbook {
  fileName: string;
  mimeType: string;
  modifiedTime?: string;
  loadedAt: string;
  checkedAt: number;
  byVin: Map<string, DriveVehicleRow>;
}

function normalizedHeader(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export function normalizeDriveVin(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function parseVehicleWeightKg(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  let text = String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/kg$/i, '');
  if (!text) return undefined;
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(text)) {
    text = text.replace(/[.,]/g, '');
  } else if (text.includes(',') && text.includes('.')) {
    const decimal = Math.max(text.lastIndexOf(','), text.lastIndexOf('.'));
    text = `${text.slice(0, decimal).replace(/[.,]/g, '')}.${text.slice(decimal + 1)}`;
  } else {
    text = text.replace(',', '.');
  }
  const parsed = Number(text.replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function xmlDecode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attribute(attributes: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`));
  return match ? xmlDecode(match[1] ?? match[2] ?? '') : undefined;
}

function textRuns(xml: string): string {
  return Array.from(xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi))
    .map((match) => xmlDecode(match[1]))
    .join('');
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? '';
  return letters.split('').reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

async function workbookSheet(
  zip: JSZip,
  requestedSheet?: string,
): Promise<{ name: string; path: string }> {
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const relationships = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbook || !relationships) {
    return { name: requestedSheet || 'Sheet1', path: 'xl/worksheets/sheet1.xml' };
  }
  const sheets = Array.from(workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)).map((match) => ({
    name: attribute(match[1], 'name') ?? '',
    relationId: attribute(match[1], 'r:id') ?? '',
  }));
  const selected =
    (requestedSheet
      ? sheets.find((sheet) => normalizedHeader(sheet.name) === normalizedHeader(requestedSheet))
      : sheets[0]) ?? sheets[0];
  if (!selected) throw new Error('Fișierul XLSX nu conține nicio foaie');
  const relation = Array.from(relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi))
    .map((match) => ({
      id: attribute(match[1], 'Id'),
      target: attribute(match[1], 'Target'),
    }))
    .find((item) => item.id === selected.relationId);
  if (!relation?.target) throw new Error(`Foaia „${selected.name}” nu poate fi deschisă`);
  const target = relation.target.replace(/^\//, '');
  const path = target.startsWith('xl/') ? target : `xl/${target.replace(/^\.\//, '')}`;
  return { name: selected.name, path };
}

async function worksheetRows(
  zip: JSZip,
  sheetPath: string,
): Promise<Array<{ rowNumber: number; cells: unknown[] }>> {
  const worksheet = await zip.file(sheetPath)?.async('string');
  if (!worksheet) throw new Error(`Foaia XLSX lipsește: ${sheetPath}`);
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const sharedStrings = sharedXml
    ? Array.from(sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi)).map((match) =>
        textRuns(match[1]),
      )
    : [];
  const rows: Array<{ rowNumber: number; cells: unknown[] }> = [];
  for (const rowMatch of worksheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const rowNumber = Number(attribute(rowMatch[1], 'r')) || rows.length + 1;
    const cells: unknown[] = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = cellMatch[1];
      const body = cellMatch[2];
      const reference = attribute(attributes, 'r') ?? '';
      const index = columnIndex(reference);
      if (index < 0) continue;
      const type = attribute(attributes, 't');
      const raw = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i)?.[1];
      if (type === 's') {
        cells[index] = sharedStrings[Number(raw)] ?? '';
      } else if (type === 'inlineStr') {
        cells[index] = textRuns(body);
      } else if (type === 'str' || type === 'e') {
        cells[index] = xmlDecode(raw ?? '');
      } else if (raw != null && raw !== '') {
        const numeric = Number(raw);
        cells[index] = Number.isFinite(numeric) ? numeric : xmlDecode(raw);
      }
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

export async function parseVehicleWorkbook(
  buffer: Buffer,
  requestedSheet?: string,
): Promise<ParsedVehicleWorkbook> {
  if (buffer.length === 0) throw new Error('Fișierul Drive este gol');
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const totalUncompressed = Object.values(zip.files).reduce((sum, entry: any) => {
    return sum + Number(entry?._data?.uncompressedSize ?? 0);
  }, 0);
  if (totalUncompressed > 100 * 1024 * 1024) {
    throw new Error('Fișierul XLSX decomprimat depășește limita de 100 MB');
  }
  const sheet = await workbookSheet(zip, requestedSheet);
  const rows = await worksheetRows(zip, sheet.path);
  const header = rows.slice(0, 30).find(({ cells }) => {
    const names = new Set(cells.map(normalizedHeader));
    return REQUIRED_COLUMNS.every((column) => names.has(normalizedHeader(column)));
  });
  if (!header) {
    throw new Error(`Lipsesc coloanele obligatorii: ${REQUIRED_COLUMNS.join(', ')}`);
  }
  const indexes = Object.fromEntries(
    REQUIRED_COLUMNS.map((column) => [
      column,
      header.cells.findIndex((cell) => normalizedHeader(cell) === normalizedHeader(column)),
    ]),
  ) as Record<(typeof REQUIRED_COLUMNS)[number], number>;

  const parsedRows: DriveVehicleRow[] = [];
  const counts = new Map<string, number>();
  for (const row of rows.filter((item) => item.rowNumber > header.rowNumber)) {
    const vin = normalizeDriveVin(row.cells[indexes['SERIE SASIU']]);
    if (!vin) continue;
    counts.set(vin, (counts.get(vin) ?? 0) + 1);
    parsedRows.push({
      vin,
      weightKg: parseVehicleWeightKg(row.cells[indexes.MASA]),
      unloadingCity: String(row.cells[indexes.LOCATIE] ?? '').trim() || undefined,
      rowNumber: row.rowNumber,
    });
  }
  return {
    sheetName: sheet.name,
    rows: parsedRows,
    duplicateVins: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([vin]) => vin),
  };
}

function driveFileId(value: string): string {
  const input = value.trim();
  return (
    input.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] ??
    input.match(/[?&]id=([A-Za-z0-9_-]+)/)?.[1] ??
    input
  );
}

function credentialsFromEnvironment(raw?: string): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  const source = raw.trim();
  const decoded = source.startsWith('{')
    ? source
    : Buffer.from(source, 'base64').toString('utf8');
  const credentials = JSON.parse(decoded) as Record<string, unknown>;
  if (typeof credentials.private_key === 'string') {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }
  return credentials;
}

function positiveConfigurationNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class DriveVehicleDataService {
  private readonly logger = new Logger(DriveVehicleDataService.name);
  private readonly fileId: string;
  private readonly sheetName?: string;
  private readonly cacheMs: number;
  private readonly maxFileBytes: number;
  private readonly auth: GoogleAuth;
  private readonly configurationError?: string;
  private cache?: DriveWorkbookCache;

  constructor(config: ConfigService) {
    this.fileId = driveFileId(
      config.get<string>('ETRANSPORT_DRIVE_FILE_ID') ??
        config.get<string>('ETRANSPORT_DRIVE_FILE_URL') ??
        '',
    );
    this.sheetName = config.get<string>('ETRANSPORT_DRIVE_SHEET_NAME')?.trim() || undefined;
    this.cacheMs = positiveConfigurationNumber(
      config.get('ETRANSPORT_DRIVE_CACHE_MS'),
      300_000,
    );
    this.maxFileBytes = positiveConfigurationNumber(
      config.get('ETRANSPORT_DRIVE_MAX_BYTES'),
      20 * 1024 * 1024,
    );
    let credentials: Record<string, unknown> | undefined;
    try {
      credentials = credentialsFromEnvironment(
        config.get<string>('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON') ??
          config.get<string>('GOOGLE_SERVICE_ACCOUNT_JSON'),
      );
    } catch {
      this.configurationError =
        'Credentialele Google Drive nu sunt JSON valid sau JSON codificat base64';
    }
    this.auth = new GoogleAuth({
      ...(credentials ? { credentials } : {}),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
  }

  get configured(): boolean {
    return Boolean(this.fileId);
  }

  async lookup(vin: string) {
    if (!this.configured) return { configured: false, match: null };
    const workbook = await this.load(false);
    return {
      configured: true,
      match: workbook.byVin.get(normalizeDriveVin(vin)) ?? null,
      source: {
        fileName: workbook.fileName,
        sheetName: workbook.sheetName,
        modifiedTime: workbook.modifiedTime,
        loadedAt: workbook.loadedAt,
      },
      duplicateVin: workbook.duplicateVins.includes(normalizeDriveVin(vin)),
    };
  }

  async status(refresh = false) {
    if (!this.configured) {
      return {
        configured: false,
        requiredColumns: REQUIRED_COLUMNS,
        message: 'Configurează ETRANSPORT_DRIVE_FILE_ID și credentialele Google read-only.',
      };
    }
    try {
      const workbook = await this.load(refresh);
      return {
        configured: true,
        connected: true,
        fileName: workbook.fileName,
        sheetName: workbook.sheetName,
        modifiedTime: workbook.modifiedTime,
        loadedAt: workbook.loadedAt,
        rowCount: workbook.rows.length,
        duplicateVins: workbook.duplicateVins,
        requiredColumns: REQUIRED_COLUMNS,
      };
    } catch (error) {
      return {
        configured: true,
        connected: false,
        error: (error as Error).message,
        requiredColumns: REQUIRED_COLUMNS,
      };
    }
  }

  private async load(force: boolean): Promise<DriveWorkbookCache> {
    if (!this.fileId) throw new Error('Fișierul Drive pentru e-Transport nu este configurat');
    if (this.configurationError) throw new Error(this.configurationError);
    const now = Date.now();
    if (!force && this.cache && now - this.cache.checkedAt < this.cacheMs) {
      return this.cache;
    }
    try {
      const client = await this.auth.getClient();
      const metadataResponse = await client.request<DriveFileMetadata>({
        url:
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(this.fileId)}` +
          '?fields=id,name,mimeType,modifiedTime,size&supportsAllDrives=true',
      });
      const metadata = metadataResponse.data;
      if (!force && this.cache && metadata.modifiedTime === this.cache.modifiedTime) {
        this.cache.checkedAt = now;
        return this.cache;
      }
      const declaredSize = Number(metadata.size ?? 0);
      if (declaredSize > this.maxFileBytes) {
        throw new Error(`Fișierul Drive depășește limita de ${this.maxFileBytes} bytes`);
      }
      const url =
        metadata.mimeType === GOOGLE_SHEET_MIME
          ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(this.fileId)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
          : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(this.fileId)}?alt=media&supportsAllDrives=true`;
      if (metadata.mimeType !== GOOGLE_SHEET_MIME && metadata.mimeType !== XLSX_MIME) {
        throw new Error(`Tip de fișier nesuportat: ${metadata.mimeType}. Este necesar XLSX sau Google Sheet.`);
      }
      const download = await client.request<ArrayBuffer>({ url, responseType: 'arraybuffer' });
      const buffer = Buffer.from(download.data);
      if (buffer.length > this.maxFileBytes) {
        throw new Error(`Fișierul Drive depășește limita de ${this.maxFileBytes} bytes`);
      }
      const parsed = await parseVehicleWorkbook(buffer, this.sheetName);
      const byVin = new Map<string, DriveVehicleRow>();
      parsed.rows.forEach((row) => {
        if (!byVin.has(row.vin)) byVin.set(row.vin, row);
      });
      this.cache = {
        ...parsed,
        fileName: metadata.name,
        mimeType: metadata.mimeType,
        modifiedTime: metadata.modifiedTime,
        loadedAt: new Date().toISOString(),
        checkedAt: now,
        byVin,
      };
      return this.cache;
    } catch (error) {
      this.logger.warn(`Drive vehicle data refresh failed: ${(error as Error).message}`);
      throw error;
    }
  }
}
