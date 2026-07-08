import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
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
        taxId: dto.taxId,
        country: dto.country ?? 'RO',
        address: dto.address,
        iban: dto.iban,
        email: dto.email,
        phone: dto.phone,
      },
    });
  }

  async update(tenantId: number, id: number, dto: UpdatePartyDto) {
    await this.get(tenantId, id);
    return this.prisma.party.update({ where: { id }, data: { ...dto, kind: dto.kind as any } });
  }
}
