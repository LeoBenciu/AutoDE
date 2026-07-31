import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
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
