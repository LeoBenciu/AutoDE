import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { normalizeEin } from '../accounting/accounting-normalizer';
import { CreatePartyDto, UpdatePartyDto } from './dto';

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

  create(tenantId: number, dto: CreatePartyDto) {
    return this.prisma.party.create({
      data: {
        tenantId,
        kind: (dto.kind as any) ?? 'COMPANY',
        name: dto.name,
        taxId: dto.taxId ? normalizeEin(dto.taxId) : undefined,
        isSupplier: dto.isSupplier ?? false,
        isClient: dto.isClient ?? false,
        supplierCode: dto.supplierCode,
        clientCode: dto.clientCode,
        supplierAnalytic: dto.supplierAnalytic,
        clientAnalytic: dto.clientAnalytic,
        registration: dto.registration,
        country: dto.country ?? 'RO',
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
