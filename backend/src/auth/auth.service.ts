import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { LoginDto, RegisterDto } from './dto';

export interface JwtPayload {
  sub: number;
  tenantId: number;
  role: string;
  email: string;
}

@Injectable()
export class AuthService {
  private readonly refreshTtlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.refreshTtlDays = Number(config.get('JWT_REFRESH_TTL_DAYS', 30));
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new UnauthorizedException('Există deja un cont cu acest email');

    const tenant = await this.prisma.tenant.create({ data: { name: dto.companyName } });
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        passwordHash: await bcrypt.hash(dto.password, 10),
        role: 'ACCOUNTANT',
        tenantId: tenant.id,
      },
    });
    return this.issueTokens(user.id, tenant.id, user.role, user.email, user.name);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Email sau parolă incorecte');
    }
    if (!user.active) throw new UnauthorizedException('Contul este dezactivat — contactează administratorul firmei');
    return this.issueTokens(user.id, user.tenantId, user.role, user.email, user.name);
  }

  async refresh(refreshToken: string) {
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row || row.revokedAt || row.expiresAt < new Date() || !row.user.active) {
      throw new UnauthorizedException('Sesiune expirată');
    }
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(row.user.id, row.user.tenantId, row.user.role, row.user.email, row.user.name);
  }

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (
      !user ||
      !user.active ||
      !(await bcrypt.compare(currentPassword, user.passwordHash))
    ) {
      throw new UnauthorizedException('Parola curentă este incorectă');
    }
    if (Buffer.byteLength(newPassword, 'utf8') > 72) {
      throw new BadRequestException('Parola nouă este prea lungă');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new BadRequestException('Parola nouă trebuie să fie diferită de parola curentă');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await this.audit.log({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.password_changed',
      entity: 'User',
      entityId: user.id,
      details: { selfService: true },
    });

    // All previous refresh sessions are revoked; issue a fresh pair for the
    // current browser so changing a password does not force an extra login.
    return this.issueTokens(
      user.id,
      user.tenantId,
      user.role,
      user.email,
      user.name,
    );
  }

  private async issueTokens(userId: number, tenantId: number, role: string, email: string, name: string) {
    const payload: JwtPayload = { sub: userId, tenantId, role, email };
    const accessToken = await this.jwt.signAsync(payload);

    const refreshToken = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * 24 * 3600 * 1000);
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: createHash('sha256').update(refreshToken).digest('hex'),
        userId,
        expiresAt,
      },
    });

    return { accessToken, refreshToken, user: { id: userId, tenantId, role, email, name } };
  }
}
