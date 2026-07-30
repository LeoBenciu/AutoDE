import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { normalizeEin } from '../accounting/accounting-normalizer';
import {
  AddCostDto,
  CreateVehicleDto,
  UpdateVehicleDto,
  VehicleSellerDto,
} from './dto';
import {
  normalizeIdentifierType,
  normalizePartyCountry,
  privateSellerIdentityErrors,
} from '../parties/party-identity';
import { ensureVehicleArticle } from '../accounting/vehicle-article';

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: number, status?: string, search?: string) {
    const where: Prisma.VehicleWhereInput = { tenantId };
    if (status) where.status = status as any;
    if (search) {
      where.OR = [
        { vin: { contains: search, mode: 'insensitive' } },
        { make: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.vehicle.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { buyer: true, seller: true },
    });
  }

  async get(tenantId: number, id: number) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, tenantId },
      include: {
        buyer: true,
        seller: true,
        costs: { include: { document: { select: { id: true, name: true } } } },
        documents: {
          where: { deletedAt: null },
          orderBy: { uploadedAt: 'desc' },
          include: { processedData: true },
        },
        contracts: true,
        transports: true,
      },
    });
    if (!vehicle) throw new NotFoundException('Vehiculul nu a fost găsit');
    const landedCost = vehicle.costs.reduce((sum, c) => sum + Number(c.amount), Number(vehicle.purchasePrice));
    const margin = vehicle.soldPrice != null ? Number(vehicle.soldPrice) - landedCost : null;
    return { ...vehicle, computedLandedCost: landedCost, margin };
  }

  async create(tenantId: number, dto: CreateVehicleDto) {
    if (dto.sellerId != null && dto.seller) {
      throw new BadRequestException('Alege un vânzător existent sau completează unul nou, nu ambele');
    }
    const vin = dto.vin.trim().toUpperCase();
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.vehicle.findFirst({ where: { tenantId, vin } });
      if (existing) throw new BadRequestException(`Există deja un vehicul cu VIN ${vin}`);
      const sellerId = await this.resolveSeller(
        tx,
        tenantId,
        dto.sellerId,
        dto.seller,
      );
      const vehicle = await tx.vehicle.create({
        data: {
          tenantId,
          vin,
          make: dto.make,
          model: dto.model,
          variant: dto.variant,
          year: dto.year,
          firstRegistered: dto.firstRegistered ? new Date(dto.firstRegistered) : undefined,
          mileageKm: dto.mileageKm,
          fuelType: dto.fuelType,
          gearbox: dto.gearbox,
          color: dto.color,
          originCountry: dto.originCountry ?? 'DE',
          purchasePrice: dto.purchasePrice,
          purchaseCurrency: dto.purchaseCurrency ?? 'EUR',
          listPrice: dto.listPrice,
          sellerId,
        },
        include: { seller: true },
      });
      await ensureVehicleArticle(tx, tenantId, vehicle);
      return vehicle;
    });
  }

  async update(tenantId: number, id: number, dto: UpdateVehicleDto) {
    if (dto.sellerId != null && dto.seller) {
      throw new BadRequestException('Alege un vânzător existent sau completează unul nou, nu ambele');
    }
    return this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      if (!vehicle) throw new NotFoundException('Vehiculul nu a fost găsit');
      if (dto.buyerId != null) {
        const buyer = await tx.party.findFirst({
          where: { id: dto.buyerId, tenantId },
          select: { id: true },
        });
        if (!buyer) throw new NotFoundException('Cumpărătorul nu a fost găsit');
      }
      const sellerId =
        dto.sellerId !== undefined || dto.seller
          ? await this.resolveSeller(tx, tenantId, dto.sellerId, dto.seller)
          : undefined;
      return tx.vehicle.update({
        where: { id },
        data: {
          status: dto.status as any,
          listPrice: dto.listPrice,
          soldPrice: dto.soldPrice,
          buyerId: dto.buyerId,
          sellerId,
          mileageKm: dto.mileageKm,
          color: dto.color,
          variant: dto.variant,
        },
        include: { buyer: true, seller: true },
      });
    });
  }

  async addCost(tenantId: number, id: number, dto: AddCostDto) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, tenantId },
      select: { purchaseCurrency: true },
    });
    if (!vehicle) throw new NotFoundException('Vehiculul nu a fost găsit');
    if (dto.currency && dto.currency !== vehicle.purchaseCurrency) {
      throw new BadRequestException(
        `Costurile manuale trebuie introduse în moneda de achiziție (${vehicle.purchaseCurrency}); documentele contabile se convertesc automat`,
      );
    }
    const cost = await this.prisma.vehicleCost.create({
      data: {
        vehicleId: id,
        category: dto.category as any,
        amount: dto.amount,
        currency: vehicle.purchaseCurrency,
        note: dto.note,
        documentId: dto.documentId,
      },
    });
    await this.recomputeLandedCost(id);
    return cost;
  }

  private async recomputeLandedCost(vehicleId: number) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { costs: true },
    });
    if (!vehicle) return;
    const landed = vehicle.costs.reduce((sum, c) => sum + Number(c.amount), Number(vehicle.purchasePrice));
    await this.prisma.vehicle.update({ where: { id: vehicleId }, data: { landedCost: landed } });
  }

  private async ensureExists(tenantId: number, id: number) {
    const v = await this.prisma.vehicle.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!v) throw new NotFoundException('Vehiculul nu a fost găsit');
  }

  private async resolveSeller(
    tx: Prisma.TransactionClient,
    tenantId: number,
    sellerId?: number | null,
    seller?: VehicleSellerDto,
  ): Promise<number | null | undefined> {
    if (sellerId !== undefined) {
      if (sellerId === null) return null;
      const existing = await tx.party.findFirst({
        where: { id: sellerId, tenantId },
        select: {
          id: true,
          kind: true,
          country: true,
          identifierType: true,
          taxId: true,
          isSupplier: true,
        },
      });
      if (!existing) throw new NotFoundException('Vânzătorul inițial nu a fost găsit');
      if (existing.kind === 'INDIVIDUAL') {
        const identityErrors = privateSellerIdentityErrors({
          kind: existing.kind,
          country: existing.country,
          identifierType: existing.identifierType,
          taxId: existing.taxId,
        });
        if (identityErrors.length > 0) {
          throw new BadRequestException(identityErrors.join('; '));
        }
      }
      if (!existing.isSupplier) {
        await tx.party.update({
          where: { id: existing.id },
          data: { isSupplier: true },
        });
      }
      return existing.id;
    }
    if (!seller) return undefined;

    const taxId = normalizeEin(seller.taxId);
    if (!taxId) {
      throw new BadRequestException(
        seller.kind === 'INDIVIDUAL'
          ? 'CNP-ul vânzătorului este obligatoriu'
          : 'CUI-ul vânzătorului este obligatoriu',
      );
    }
    const country = normalizePartyCountry(seller.country);
    const identifierType = normalizeIdentifierType(
      seller.identifierType,
      seller.kind,
      country,
    );
    if (seller.kind === 'INDIVIDUAL') {
      const identityErrors = privateSellerIdentityErrors({
        kind: seller.kind,
        country,
        identifierType,
        taxId,
      });
      if (identityErrors.length > 0) {
        throw new BadRequestException(identityErrors.join('; '));
      }
    }
    const existing = await tx.party.findFirst({ where: { tenantId, taxId } });
    if (existing) {
      const updated = await tx.party.update({
        where: { id: existing.id },
        data: {
          kind: seller.kind,
          identifierType,
          name: seller.name,
          isSupplier: true,
          country,
          address: seller.address || existing.address,
        },
      });
      return updated.id;
    }
    const created = await tx.party.create({
      data: {
        tenantId,
        kind: seller.kind,
        identifierType,
        name: seller.name,
        taxId,
        isSupplier: true,
        country,
        address: seller.address,
      },
    });
    return created.id;
  }
}
