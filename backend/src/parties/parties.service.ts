import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { normalizeEin } from '../accounting/accounting-normalizer';
import { parseCsv, pick } from '../common/csv';
import { CreatePartyDto, UpdatePartyDto } from './dto';

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
    if (taxId) {
      const existing = await this.prisma.party.findFirst({
        where: { tenantId, taxId },
      });
      if (existing) {
        return this.prisma.party.update({
          where: { id: existing.id },
          data: {
            kind: (dto.kind as any) ?? existing.kind,
            name: dto.name,
            isSupplier: dto.isSupplier ?? existing.isSupplier,
            isClient: dto.isClient ?? existing.isClient,
            supplierCode: dto.supplierCode ?? existing.supplierCode,
            clientCode: dto.clientCode ?? existing.clientCode,
            supplierAnalytic: dto.supplierAnalytic ?? existing.supplierAnalytic,
            clientAnalytic: dto.clientAnalytic ?? existing.clientAnalytic,
            registration: dto.registration ?? existing.registration,
            country: dto.country?.toUpperCase() ?? existing.country,
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
    return this.prisma.party.create({
      data: {
        tenantId,
        kind: (dto.kind as any) ?? inferPartyKind(taxId),
        name: dto.name,
        taxId,
        isSupplier: dto.isSupplier ?? false,
        isClient: dto.isClient ?? false,
        supplierCode: dto.supplierCode,
        clientCode: dto.clientCode,
        supplierAnalytic: dto.supplierAnalytic,
        clientAnalytic: dto.clientAnalytic,
        registration: dto.registration,
        country: dto.country?.toUpperCase() ?? 'RO',
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
    if (!file?.buffer?.length) throw new BadRequestException('Fișier CSV gol sau lipsă');
    const rows = parseCsv(file.buffer);
    if (rows.length === 0) throw new BadRequestException('Fișierul CSV nu conține date');

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = pick(row, 'name', 'denumire', 'nume', 'partener');
      if (!name) {
        errors.push(`Rândul ${index + 2}: lipsește denumirea`);
        continue;
      }
      const rawTaxId = pick(row, 'taxid', 'cui', 'cif', 'ein', 'cod fiscal', 'cnp');
      const taxId = rawTaxId ? normalizeEin(rawTaxId) : undefined;
      const code = pick(row, 'code', 'cod', 'cod partener');
      const analytic = pick(row, 'analytic', 'analitic', 'cont analitic');

      const shared = {
        kind: importedPartyKind(pick(row, 'kind', 'tip', 'tip partener'), taxId),
        name,
        registration: pick(row, 'registration', 'regcom', 'reg com', 'nr reg com') ?? undefined,
        country: (pick(row, 'country', 'tara') ?? 'RO').toUpperCase(),
        county: pick(row, 'county', 'judet') ?? undefined,
        city: pick(row, 'city', 'localitate', 'oras') ?? undefined,
        address: pick(row, 'address', 'adresa') ?? undefined,
        iban: pick(row, 'iban', 'cont bancar', 'contbancar') ?? undefined,
        bankName: pick(row, 'bankname', 'banca') ?? undefined,
        email: pick(row, 'email', 'e-mail') ?? undefined,
        phone: pick(row, 'phone', 'telefon', 'tel') ?? undefined,
        discount: pick(row, 'discount', 'reducere') ?? undefined,
      };
      const roleData =
        role === 'supplier'
          ? { isSupplier: true, supplierCode: code, supplierAnalytic: analytic }
          : { isClient: true, clientCode: code, clientAnalytic: analytic };

      // Match an existing partner by tax id, then by role-specific code.
      const existing = await this.prisma.party.findFirst({
        where: {
          tenantId,
          ...(taxId
            ? { taxId }
            : code
              ? role === 'supplier'
                ? { supplierCode: code }
                : { clientCode: code }
              : { id: -1 }),
        },
      });

      if (existing) {
        await this.prisma.party.update({
          where: { id: existing.id },
          data: { ...shared, ...roleData, taxId: taxId ?? existing.taxId },
        });
        updated += 1;
      } else {
        await this.prisma.party.create({
          data: { tenantId, taxId, ...shared, ...roleData },
        });
        created += 1;
      }
    }
    return { created, updated, total: rows.length, errors };
  }

  async update(tenantId: number, id: number, dto: UpdatePartyDto) {
    await this.get(tenantId, id);
    return this.prisma.party.update({
      where: { id },
      data: {
        ...dto,
        taxId: dto.taxId ? normalizeEin(dto.taxId) : dto.taxId,
        kind: dto.kind as any,
      },
    });
  }
}

function inferPartyKind(taxId?: string): 'INDIVIDUAL' | 'COMPANY' {
  return taxId && /^\d{13}$/.test(taxId) ? 'INDIVIDUAL' : 'COMPANY';
}

function importedPartyKind(
  value: string | undefined,
  taxId?: string,
): 'INDIVIDUAL' | 'COMPANY' {
  const normalized = value?.trim().toUpperCase();
  if (
    normalized &&
    ['INDIVIDUAL', 'PERSOANA FIZICA', 'PERSOANĂ FIZICĂ', 'PF'].includes(normalized)
  ) {
    return 'INDIVIDUAL';
  }
  return inferPartyKind(taxId);
}
