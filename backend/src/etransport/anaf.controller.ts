import { Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as crypto from 'crypto';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { AnafClient } from './anaf-client';

const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * The OAuth `state` doubles as CSRF protection and the carrier of the tenant id:
 * the callback arrives as a top-level browser redirect from ANAF without our
 * JWT, so the tenant is recovered from this HMAC-signed, short-lived value.
 */
function signState(secret: string, tenantId: number): string {
  const payload = Buffer.from(
    JSON.stringify({ t: tenantId, e: Date.now() + STATE_TTL_MS }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyState(secret: string, state: string): number | null {
  const [payload, sig] = (state ?? '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const { t, e } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      t: number;
      e: number;
    };
    if (typeof t !== 'number' || typeof e !== 'number' || Date.now() > e) return null;
    return t;
  } catch {
    return null;
  }
}

@Controller('etransport/anaf')
export class AnafController {
  constructor(
    private readonly anaf: AnafClient,
    private readonly config: ConfigService,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.anaf.getConnectionStatus(user.tenantId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ACCOUNTANT')
  @Get('authorize-url')
  authorizeUrl(@CurrentUser() user: AuthUser) {
    const state = signState(this.config.get('JWT_SECRET', ''), user.tenantId);
    return { url: this.anaf.buildAuthorizeUrl(state) };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ACCOUNTANT')
  @Post('disconnect')
  async disconnect(@CurrentUser() user: AuthUser) {
    await this.anaf.disconnect(user.tenantId);
    return { connected: false };
  }

  // No guard: ANAF redirects the browser here with no JWT; the signed state
  // carries the tenant and protects against forgery.
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const frontend = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/+$/, '');
    const back = (params: string) => res.redirect(`${frontend}/setari?${params}`);
    if (error) return back(`anaf=error&reason=${encodeURIComponent(error)}`);
    const tenantId = verifyState(this.config.get('JWT_SECRET', ''), state);
    if (tenantId == null) return back('anaf=error&reason=state_invalid');
    if (!code) return back('anaf=error&reason=missing_code');
    try {
      await this.anaf.connectWithCode(tenantId, code);
      return back('anaf=connected');
    } catch (e) {
      return back(`anaf=error&reason=${encodeURIComponent((e as Error).message.slice(0, 200))}`);
    }
  }
}
