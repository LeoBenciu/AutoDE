import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AddCostDto, CreateVehicleDto, UpdateVehicleDto } from './dto';

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
    const existing = await this.prisma.vehicle.findFirst({ where: { tenantId, vin: dto.vin } });
    if (existing) throw new BadRequestException(`Există deja un vehicul cu VIN ${dto.vin}`);
    return this.prisma.vehicle.create({
      data: {
        tenantId,
        vin: dto.vin.toUpperCase(),
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
        sellerId: dto.sellerId,
      },
    });
  }

  async update(tenantId: number, id: number, dto: UpdateVehicleDto) {
    await this.ensureExists(tenantId, id);
    return this.prisma.vehicle.update({
      where: { id },
      data: {
        status: dto.status as any,
        listPrice: dto.listPrice,
        soldPrice: dto.soldPrice,
        buyerId: dto.buyerId,
        mileageKm: dto.mileageKm,
        color: dto.color,
        variant: dto.variant,
      },
    });
  }

  async addCost(tenantId: number, id: number, dto: AddCostDto) {
    await this.ensureExists(tenantId, id);
    const cost = await this.prisma.vehicleCost.create({
      data: {
        vehicleId: id,
        category: dto.category as any,
        amount: dto.amount,
        currency: dto.currency ?? 'EUR',
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
}
