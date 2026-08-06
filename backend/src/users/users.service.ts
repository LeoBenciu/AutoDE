import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';

const SAFE_SELECT = { id: true, email: true, name: true, role: true, active: true, createdAt: true };

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: number) {
    return this.prisma.user.findMany({
      where: { tenantId },
      select: SAFE_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(
    tenantId: number,
    actorId: number,
    dto: { name: string; email: string; password: string; role: string },
  ) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new BadRequestException('Există deja un cont cu acest email');

    const user = await this.prisma.user.create({
      data: {
        tenantId,
        name: dto.name,
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 10),
        role: dto.role as any,
      },
      select: SAFE_SELECT,
    });
    await this.audit.log({
      tenantId,
      userId: actorId,
      action: 'user.created',
      entity: 'User',
      entityId: user.id,
      details: { email: dto.email, role: dto.role },
    });
    return user;
  }

  async update(
    tenantId: number,
    actorId: number,
    id: number,
    dto: { name?: string; role?: string; active?: boolean; password?: string },
  ) {
    const user = await this.prisma.user.findFirst({ where: { id, tenantId } });
    if (!user) throw new NotFoundException('Utilizatorul nu a fost găsit');

    if (dto.password && Buffer.byteLength(dto.password, 'utf8') > 72) {
      throw new BadRequestException('Parola nouă este prea lungă');
    }

    if (id === actorId && (dto.role !== undefined || dto.active === false)) {
      throw new BadRequestException('Nu îți poți schimba propriul rol și nu te poți dezactiva singur');
    }
    // Never leave the tenant without an active administrator.
    if (
      user.role === 'ACCOUNTANT' &&
      (dto.active === false || (dto.role && dto.role !== 'ACCOUNTANT'))
    ) {
      const accountants = await this.prisma.user.count({
        where: { tenantId, role: 'ACCOUNTANT', active: true },
      });
      if (accountants <= 1) {
        throw new BadRequestException(
          'Firma trebuie să aibă cel puțin un contabil activ',
        );
      }
    }

    const passwordHash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : undefined;
    const updated = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.user.update({
        where: { id },
        data: {
          name: dto.name,
          role: dto.role as any,
          active: dto.active,
          passwordHash,
        },
        select: SAFE_SELECT,
      });
      if (passwordHash) {
        await transaction.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      return result;
    });
    await this.audit.log({
      tenantId,
      userId: actorId,
      action: 'user.updated',
      entity: 'User',
      entityId: id,
      details: { role: dto.role, active: dto.active, passwordChanged: Boolean(dto.password) },
    });
    return updated;
  }
}
