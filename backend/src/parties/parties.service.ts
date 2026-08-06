import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { normalizeEin } from '../accounting/accounting-normalizer';
import { normalizeCsvHeader, parseCsv, pick } from '../common/csv';
import { CreatePartyDto, UpdatePartyDto } from './dto';
import {
  PartyIdentifierTypeValue,
  PartyKindValue,
  normalizeIdentifierType,
  normalizePartyCountry,
  privateSellerIdentityErrors,
} from './party-identity';

export interface UploadedCsv {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

export type PartyRole = 'supplier' | 'client';

@Injectable()
export class PartiesService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: number, search?: string) {
    return this.prisma.party.findMany({
      where: {
        tenantId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { taxId: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  async get(tenantId: number, id: number) {
    const party = await this.prisma.party.findFirst({ where: { id, tenantId } });
    if (!party) throw new NotFoundException('Partenerul nu a fost găsit');
    return party;
  }

  async create(tenantId: number, dto: CreatePartyDto) {
    const taxId = dto.taxId ? normalizeEin(dto.taxId) : undefined;
    const kind = ((dto.kind as 'INDIVIDUAL' | 'COMPANY' | undefined) ??
      inferPartyKind(taxId));
    const country = normalizePartyCountry(dto.country);
    const identifierType = normalizeIdentifierType(undefined, kind, country);
    if (taxId) {
      const existing = await this.prisma.party.findFirst({
        where: { tenantId, taxId },
      });
      if (existing) {
        const resultingKind =
          (dto.kind as 'INDIVIDUAL' | 'COMPANY' | undefined) ?? existing.kind;
        const resultingCountry = dto.country
          ? normalizePartyCountry(dto.country)
          : existing.country;
        const resultingIdentifierType = normalizeIdentifierType(
          undefined,
          resultingKind,
          resultingCountry,
        );
        assertPrivateSupplierIdentity({
          kind: resultingKind,
          country: resultingCountry,
          identifierType: resultingIdentifierType,
          taxId,
          isSupplier: dto.isSupplier ?? existing.isSupplier,
        });
        return this.prisma.party.update({
          where: { id: existing.id },
          data: {
            kind: resultingKind,
            identifierType: resultingIdentifierType,
            name: dto.name,
            isSupplier: dto.isSupplier ?? existing.isSupplier,
            isClient: dto.isClient ?? existing.isClient,
            supplierCode: dto.supplierCode ?? existing.supplierCode,
            clientCode: dto.clientCode ?? existing.clientCode,
            supplierAnalytic: dto.supplierAnalytic ?? existing.supplierAnalytic,
            clientAnalytic: dto.clientAnalytic ?? existing.clientAnalytic,
            registration: dto.registration ?? existing.registration,
            country: resultingCountry,
            county: dto.county ?? existing.county,
            city: dto.city ?? existing.city,
            address: dto.address ?? existing.address,
            iban: dto.iban ?? existing.iban,
            bankName: dto.bankName ?? existing.bankName,
            email: dto.email ?? existing.email,
            phone: dto.phone ?? existing.phone,
            discount: dto.discount ?? existing.discount,
          },
        });
      }
    }
    assertPrivateSupplierIdentity({
      kind,
      country,
      identifierType,
      taxId,
      isSupplier: dto.isSupplier ?? false,
    });
    return this.prisma.party.create({
      data: {
        tenantId,
        kind,
        identifierType,
        name: dto.name,
        taxId,
        isSupplier: dto.isSupplier ?? false,
        isClient: dto.isClient ?? false,
        supplierCode: dto.supplierCode,
        clientCode: dto.clientCode,
        supplierAnalytic: dto.supplierAnalytic,
        clientAnalytic: dto.clientAnalytic,
        registration: dto.registration,
        country,
        county: dto.county,
        city: dto.city,
        address: dto.address,
        iban: dto.iban,
        bankName: dto.bankName,
        email: dto.email,
        phone: dto.phone,
        discount: dto.discount,
      },
    });
  }

  async import(tenantId: number, role: PartyRole, file?: UploadedCsv) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Fișier CSV/XML gol sau lipsă');
    }
    const rows = parsePartyImportRows(file);
    if (rows.length === 0) {
      throw new BadRequestException('Fișierul CSV/XML nu conține parteneri');
    }

    const storedParties = await this.prisma.party.findMany({ where: { tenantId } });
    const parties: WorkingParty[] = storedParties.map((party) => ({
      ...party,
      kind: party.kind as PartyKindValue,
      identifierType: party.identifierType as PartyIdentifierTypeValue | null,
    }));
    const taxIdIndex = new Map<string, Set<WorkingParty>>();
    const supplierCodeIndex = new Map<string, Set<WorkingParty>>();
    const clientCodeIndex = new Map<string, Set<WorkingParty>>();
    const nameCountryIndex = new Map<string, Set<WorkingParty>>();
    for (const party of parties) indexParty(party, {
      taxIdIndex,
      supplierCodeIndex,
      clientCodeIndex,
      nameCountryIndex,
    });

    let created = 0;
    let updated = 0;
    let identifiersFilled = 0;
    let identifierTypesCorrected = 0;
    let identificationNumbersRead = 0;
    let matchedByIdentification = 0;
    let matchedByCode = 0;
    let matchedByName = 0;
    const errors: string[] = [];
    const changed = new Set<WorkingParty>();
    const initiallyMissingIdentifiers = new Set(
      parties.filter((party) => !party.taxId).map((party) => party.id),
    );
    const correctedIdentifierTypes = new Set<number>();

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = pick(
        row,
        'name',
        'denumire',
        'nume',
        'partener',
        role === 'supplier' ? 'furnizor' : 'client',
        role === 'supplier' ? 'denumire furnizor' : 'denumire client',
        role === 'supplier' ? 'nume furnizor' : 'nume client',
      );
      if (!name) {
        errors.push(`Rândul ${index + 2}: lipsește denumirea`);
        continue;
      }
      const rawTaxId = pickIdentificationNumber(row);
      const normalizedTaxId = rawTaxId ? normalizeEin(rawTaxId) : '';
      const taxId = normalizedTaxId || undefined;
      if (taxId) identificationNumbersRead += 1;
      const code = pick(
        row,
        'code',
        'cod',
        'cod partener',
        'nr',
        role === 'supplier' ? 'cod furnizor' : 'cod client',
      );
      const analytic = pick(row, 'analytic', 'analitic', 'cont analitic');
      const importedCountry = pick(row, 'country', 'tara');
      let country = normalizePartyCountry(importedCountry);
      const codeMatches = indexedMatches(
        role === 'supplier' ? supplierCodeIndex : clientCodeIndex,
        partyCodeKey(code),
      );
      const taxIdMatches = indexedMatches(taxIdIndex, taxId);
      if (taxIdMatches.length > 1) {
        errors.push(
          `Rândul ${index + 2}: numărul de identificare ${rawTaxId} există la mai mulți parteneri; completează manual înregistrările duplicate`,
        );
        continue;
      }
      if (codeMatches.length > 1) {
        errors.push(
          `Rândul ${index + 2}: codul ${code} există la mai mulți ${role === 'supplier' ? 'furnizori' : 'clienți'}`,
        );
        continue;
      }
      if (
        taxIdMatches[0] &&
        codeMatches[0] &&
        taxIdMatches[0] !== codeMatches[0]
      ) {
        errors.push(
          `Rândul ${index + 2}: numărul de identificare și codul SAGA indică parteneri diferiți`,
        );
        continue;
      }

      let matchSource: 'identification' | 'code' | 'name' | undefined;
      let existing = taxIdMatches[0] ?? codeMatches[0];
      if (taxIdMatches[0]) matchSource = 'identification';
      else if (codeMatches[0]) matchSource = 'code';
      if (!existing) {
        const nameMatches = indexedMatches(
          nameCountryIndex,
          partyNameCountryKey(name, country),
        );
        if (nameMatches.length === 1) {
          const candidate = nameMatches[0];
          if (
            !taxId ||
            !candidate.taxId ||
            normalizeEin(candidate.taxId) === taxId
          ) {
            existing = candidate;
            matchSource = 'name';
          }
        }
      }
      country = normalizePartyCountry(importedCountry ?? existing?.country);
      if (
        existing?.taxId &&
        taxId &&
        normalizeEin(existing.taxId) !== taxId
      ) {
        errors.push(
          `Rândul ${index + 2}: ${existing.name} are deja numărul de identificare ${existing.taxId}; valoarea ${rawTaxId} nu a fost suprascrisă`,
        );
        continue;
      }

      const kind = importedPartyKind(
        pick(row, 'kind', 'tip', 'tip partener'),
        taxId ?? existing?.taxId ?? undefined,
        country,
        existing?.kind,
      );
      const identifierType = normalizeIdentifierType(undefined, kind, country);
      const identityErrors =
        role === 'supplier'
          ? privateSellerIdentityErrors({
              kind,
              country,
              identifierType,
              taxId: taxId ?? existing?.taxId,
            })
          : [];
      if (kind === 'INDIVIDUAL' && identityErrors.length > 0) {
        errors.push(`Rândul ${index + 2}: ${identityErrors.join('; ')}`);
        continue;
      }

      if (existing) {
        if (matchSource === 'identification') matchedByIdentification += 1;
        else if (matchSource === 'code') matchedByCode += 1;
        else if (matchSource === 'name') matchedByName += 1;
        const priorIdentifierType = existing.identifierType;
        if (
          taxId &&
          !existing.taxId &&
          existing.id != null &&
          initiallyMissingIdentifiers.has(existing.id)
        ) {
          identifiersFilled += 1;
          initiallyMissingIdentifiers.delete(existing.id);
        }
        mergeImportedParty(existing, {
          role,
          kind,
          identifierType,
          name,
          taxId,
          code,
          analytic,
          country,
          registration: pick(row, 'registration', 'regcom', 'reg com', 'nr reg com'),
          county: pick(row, 'county', 'judet'),
          city: pick(row, 'city', 'localitate', 'oras'),
          address: pick(row, 'address', 'adresa'),
          iban: pick(row, 'iban', 'cont bancar', 'contbancar', 'cont banca'),
          bankName: pick(row, 'bankname', 'banca'),
          email: pick(row, 'email', 'e-mail'),
          phone: pick(row, 'phone', 'telefon', 'tel'),
          discount: pick(row, 'discount', 'reducere'),
        });
        if (
          existing.id != null &&
          priorIdentifierType !== existing.identifierType &&
          !correctedIdentifierTypes.has(existing.id)
        ) {
          identifierTypesCorrected += 1;
          correctedIdentifierTypes.add(existing.id);
        }
        indexParty(existing, {
          taxIdIndex,
          supplierCodeIndex,
          clientCodeIndex,
          nameCountryIndex,
        });
        changed.add(existing);
        updated += 1;
      } else {
        const party = newWorkingParty({
          tenantId,
          role,
          kind,
          identifierType,
          name,
          taxId,
          code,
          analytic,
          country,
          registration: pick(row, 'registration', 'regcom', 'reg com', 'nr reg com'),
          county: pick(row, 'county', 'judet'),
          city: pick(row, 'city', 'localitate', 'oras'),
          address: pick(row, 'address', 'adresa'),
          iban: pick(row, 'iban', 'cont bancar', 'contbancar', 'cont banca'),
          bankName: pick(row, 'bankname', 'banca'),
          email: pick(row, 'email', 'e-mail'),
          phone: pick(row, 'phone', 'telefon', 'tel'),
          discount: pick(row, 'discount', 'reducere'),
        });
        parties.push(party);
        changed.add(party);
        indexParty(party, {
          taxIdIndex,
          supplierCodeIndex,
          clientCodeIndex,
          nameCountryIndex,
        });
        created += 1;
      }
    }

    const writes = [...changed].map((party) =>
      party.id == null
        ? () => this.prisma.party.create({ data: persistedPartyData(party) })
        : () =>
            this.prisma.party.update({
              where: { id: party.id! },
              data: persistedPartyData(party),
            }),
    );
    for (let index = 0; index < writes.length; index += 100) {
      await this.prisma.$transaction(
        writes.slice(index, index + 100).map((write) => write()),
      );
    }
    return {
      created,
      updated,
      total: rows.length,
      identifiersFilled,
      identifierTypesCorrected,
      duplicatesAvoided: updated,
      identificationNumbersRead,
      rowsWithoutIdentification: rows.length - identificationNumbersRead,
      matchedByIdentification,
      matchedByCode,
      matchedByName,
      errors,
    };
  }

  async update(tenantId: number, id: number, dto: UpdatePartyDto) {
    const existing = await this.get(tenantId, id);
    const taxId =
      dto.taxId !== undefined
        ? dto.taxId
          ? normalizeEin(dto.taxId)
          : null
        : existing.taxId;
    const kind =
      (dto.kind as 'INDIVIDUAL' | 'COMPANY' | undefined) ?? existing.kind;
    const country = normalizePartyCountry(dto.country ?? existing.country);
    const identifierType = normalizeIdentifierType(undefined, kind, country);
    assertPrivateSupplierIdentity({
      kind,
      country,
      identifierType,
      taxId,
      isSupplier: dto.isSupplier ?? existing.isSupplier,
    });
    return this.prisma.party.update({
      where: { id },
      data: {
        ...dto,
        taxId,
        kind,
        country,
        identifierType,
      },
    });
  }
}

function assertPrivateSupplierIdentity(input: {
  kind: 'INDIVIDUAL' | 'COMPANY';
  country: string;
  identifierType: 'CUI' | 'CNP' | 'FOREIGN_ID';
  taxId?: string | null;
  isSupplier: boolean;
}) {
  if (!input.isSupplier || input.kind !== 'INDIVIDUAL') return;
  const errors = privateSellerIdentityErrors(input);
  if (errors.length > 0) throw new BadRequestException(errors.join('; '));
}

function inferPartyKind(taxId?: string): 'INDIVIDUAL' | 'COMPANY' {
  return taxId && /^\d{13}$/.test(taxId) ? 'INDIVIDUAL' : 'COMPANY';
}

function importedPartyKind(
  value: string | undefined,
  taxId?: string,
  country?: string,
  existingKind?: PartyKindValue,
): 'INDIVIDUAL' | 'COMPANY' {
  const normalized = value?.trim().toUpperCase();
  if (
    normalized &&
    ['INDIVIDUAL', 'PERSOANA FIZICA', 'PERSOANĂ FIZICĂ', 'PF'].includes(normalized)
  ) {
    return 'INDIVIDUAL';
  }
  if (
    normalized &&
    ['COMPANY', 'COMPANIE', 'PERSOANA JURIDICA', 'PERSOANĂ JURIDICĂ', 'PJ'].includes(
      normalized,
    )
  ) {
    return 'COMPANY';
  }
  if (
    normalizePartyCountry(country) === 'RO' &&
    taxId &&
    /^\d{13}$/.test(taxId)
  ) {
    return 'INDIVIDUAL';
  }
  return existingKind ?? 'COMPANY';
}

interface WorkingParty {
  id: number | null;
  tenantId: number;
  kind: PartyKindValue;
  identifierType: PartyIdentifierTypeValue | null;
  name: string;
  taxId: string | null;
  isSupplier: boolean;
  isClient: boolean;
  supplierCode: string | null;
  clientCode: string | null;
  supplierAnalytic: string | null;
  clientAnalytic: string | null;
  registration: string | null;
  country: string;
  county: string | null;
  city: string | null;
  address: string | null;
  iban: string | null;
  bankName: string | null;
  email: string | null;
  phone: string | null;
  discount: string | null;
}

interface PartyIndexes {
  taxIdIndex: Map<string, Set<WorkingParty>>;
  supplierCodeIndex: Map<string, Set<WorkingParty>>;
  clientCodeIndex: Map<string, Set<WorkingParty>>;
  nameCountryIndex: Map<string, Set<WorkingParty>>;
}

interface ImportedPartyValues {
  role: PartyRole;
  kind: PartyKindValue;
  identifierType: PartyIdentifierTypeValue;
  name: string;
  taxId?: string;
  code?: string;
  analytic?: string;
  country: string;
  registration?: string;
  county?: string;
  city?: string;
  address?: string;
  iban?: string;
  bankName?: string;
  email?: string;
  phone?: string;
  discount?: string;
}

function parsePartyImportRows(file: UploadedCsv): Record<string, string>[] {
  const text = file.buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  const isXml =
    file.originalname.toLowerCase().endsWith('.xml') ||
    /xml/i.test(file.mimetype) ||
    text.startsWith('<');
  return isXml ? parseSagaPartyXml(text) : parseCsv(file.buffer);
}

function parseSagaPartyXml(xml: string): Record<string, string>[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new BadRequestException('Fișierul XML conține declarații nepermise');
  }
  const rows: Record<string, string>[] = [];
  for (const line of xml.matchAll(/<Linie\b[^>]*>([\s\S]*?)<\/Linie>/gi)) {
    const row: Record<string, string> = {};
    for (const field of line[1].matchAll(
      /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g,
    )) {
      row[normalizeCsvHeader(field[1])] = decodeXmlText(
        field[2].replace(/<[^>]+>/g, ''),
      ).trim();
    }
    rows.push(row);
  }
  return rows;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function indexedMatches(
  index: Map<string, Set<WorkingParty>>,
  value?: string,
): WorkingParty[] {
  const key = normalizedIndexKey(value);
  return key ? [...(index.get(key) ?? [])] : [];
}

function addToIndex(
  index: Map<string, Set<WorkingParty>>,
  value: string | null | undefined,
  party: WorkingParty,
) {
  const key = normalizedIndexKey(value);
  if (!key) return;
  const matches = index.get(key) ?? new Set<WorkingParty>();
  matches.add(party);
  index.set(key, matches);
}

function indexParty(party: WorkingParty, indexes: PartyIndexes) {
  addToIndex(
    indexes.taxIdIndex,
    party.taxId ? normalizeEin(party.taxId) : party.taxId,
    party,
  );
  addToIndex(
    indexes.supplierCodeIndex,
    partyCodeKey(party.supplierCode),
    party,
  );
  addToIndex(indexes.clientCodeIndex, partyCodeKey(party.clientCode), party);
  addToIndex(
    indexes.nameCountryIndex,
    partyNameCountryKey(party.name, party.country),
    party,
  );
}

function normalizedIndexKey(value?: string | null): string {
  return String(value ?? '').trim().toUpperCase();
}

function partyCodeKey(value?: string | null): string {
  const normalized = normalizedIndexKey(value).replace(/\.0+$/, '');
  if (/^\d+$/.test(normalized)) return normalized.replace(/^0+(?=\d)/, '');
  return normalized;
}

function pickIdentificationNumber(
  row: Record<string, string>,
): string | undefined {
  const exact = pick(
    row,
    'taxid',
    'cui',
    'cif',
    'ein',
    'cod fiscal',
    'cod_fiscal',
    'cnp',
    'cui cnp',
    'cnp cui',
    'cui cnp id extern',
    'cif cnp',
    'cod fiscal cnp',
    'identificator',
    'id extern',
    'numar identificare',
    'număr identificare',
    'identification number',
    'vat number',
  );
  if (exact) return exact;
  for (const [header, value] of Object.entries(row)) {
    if (!value?.trim() || header.includes('tip')) continue;
    if (
      header.includes('codfiscal') ||
      header.includes('identific') ||
      header.includes('vatnumber') ||
      header.includes('cui') ||
      header.includes('cif') ||
      header.includes('cnp')
    ) {
      return value.trim();
    }
  }
  return undefined;
}

function partyNameCountryKey(name: string, country: string): string {
  const normalizedName = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  return `${normalizedName}|${normalizePartyCountry(country)}`;
}

function mergeImportedParty(
  party: WorkingParty,
  values: ImportedPartyValues,
) {
  party.kind = values.kind;
  party.identifierType = values.identifierType;
  party.name = values.name;
  party.taxId = values.taxId ?? party.taxId;
  party.country = values.country;
  party.registration = values.registration ?? party.registration;
  party.county = values.county ?? party.county;
  party.city = values.city ?? party.city;
  party.address = values.address ?? party.address;
  party.iban = values.iban ?? party.iban;
  party.bankName = values.bankName ?? party.bankName;
  party.email = values.email ?? party.email;
  party.phone = values.phone ?? party.phone;
  party.discount = values.discount ?? party.discount;
  if (values.role === 'supplier') {
    party.isSupplier = true;
    party.supplierCode = values.code ?? party.supplierCode;
    party.supplierAnalytic = values.analytic ?? party.supplierAnalytic;
  } else {
    party.isClient = true;
    party.clientCode = values.code ?? party.clientCode;
    party.clientAnalytic = values.analytic ?? party.clientAnalytic;
  }
}

function newWorkingParty(
  values: ImportedPartyValues & { tenantId: number },
): WorkingParty {
  const party: WorkingParty = {
    id: null,
    tenantId: values.tenantId,
    kind: values.kind,
    identifierType: values.identifierType,
    name: values.name,
    taxId: values.taxId ?? null,
    isSupplier: false,
    isClient: false,
    supplierCode: null,
    clientCode: null,
    supplierAnalytic: null,
    clientAnalytic: null,
    registration: values.registration ?? null,
    country: values.country,
    county: values.county ?? null,
    city: values.city ?? null,
    address: values.address ?? null,
    iban: values.iban ?? null,
    bankName: values.bankName ?? null,
    email: values.email ?? null,
    phone: values.phone ?? null,
    discount: values.discount ?? null,
  };
  mergeImportedParty(party, values);
  return party;
}

function persistedPartyData(party: WorkingParty) {
  return {
    tenantId: party.tenantId,
    kind: party.kind,
    identifierType: party.identifierType,
    name: party.name,
    taxId: party.taxId,
    isSupplier: party.isSupplier,
    isClient: party.isClient,
    supplierCode: party.supplierCode,
    clientCode: party.clientCode,
    supplierAnalytic: party.supplierAnalytic,
    clientAnalytic: party.clientAnalytic,
    registration: party.registration,
    country: party.country,
    county: party.county,
    city: party.city,
    address: party.address,
    iban: party.iban,
    bankName: party.bankName,
    email: party.email,
    phone: party.phone,
    discount: party.discount,
  };
}
