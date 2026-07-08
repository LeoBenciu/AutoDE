import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';

const TOKEN_SAFETY_WINDOW_MS = 5 * 60 * 1000;

/**
 * ANAF OAuth2 + e-Transport web-service client.
 *
 * Auth follows the logincert.anaf.ro pattern (qualified certificate enrolled
 * in SPV). Tokens are stored per tenant and refreshed proactively inside a
 * safety window. When ANAF credentials are not configured the client degrades
 * gracefully with a clear error instead of crashing.
 */
@Injectable()
export class AnafClient {
  private readonly logger = new Logger(AnafClient.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.get('ANAF_CLIENT_ID') && this.config.get('ANAF_CLIENT_SECRET'));
  }

  private get baseUrl(): string {
    return this.config.get('ANAF_ETRANSPORT_BASE_URL', 'https://api.anaf.ro/test/ETRANSPORT/ws/v1');
  }

  async getAccessToken(tenantId: number): Promise<string> {
    if (!this.configured) {
      throw new BadRequestException(
        'Integrarea ANAF nu este configurată. Setează ANAF_CLIENT_ID/ANAF_CLIENT_SECRET și înrolează certificatul în SPV.',
      );
    }
    const row = await this.prisma.anafToken.findUnique({ where: { tenantId } });
    if (!row) {
      throw new BadRequestException(
        'Contul ANAF nu este conectat pentru această firmă. Finalizează fluxul OAuth2 cu certificatul calificat.',
      );
    }
    if (row.expiresAt.getTime() - Date.now() > TOKEN_SAFETY_WINDOW_MS) {
      return row.accessToken;
    }
    return this.refreshToken(tenantId, row.refreshToken);
  }

  private async refreshToken(tenantId: number, refreshToken: string): Promise<string> {
    const tokenUrl = this.config.get('ANAF_TOKEN_URL', 'https://logincert.anaf.ro/anaf-oauth2/v1/token');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.get('ANAF_CLIENT_ID', ''),
      client_secret: this.config.get('ANAF_CLIENT_SECRET', ''),
    });
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new BadRequestException(
        `Reînnoirea token-ului ANAF a eșuat (${res.status}). Reconectează contul ANAF din setări.`,
      );
    }
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    await this.prisma.anafToken.update({
      where: { tenantId },
      data: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
      },
    });
    return data.access_token;
  }

  /** Submit the XML declaration; returns the ANAF upload index. */
  async submitDeclaration(tenantId: number, cui: string, xml: string): Promise<string> {
    const token = await this.getAccessToken(tenantId);
    const res = await fetch(`${this.baseUrl}/upload/ETRANSP/${cui}/2`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/xml' },
      body: xml,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new BadRequestException(`ANAF a respins declarația (${res.status}): ${text.slice(0, 300)}`);
    }
    const indexMatch = text.match(/index_incarcare="?(\d+)/);
    if (!indexMatch) {
      throw new BadRequestException(`Răspuns ANAF neașteptat: ${text.slice(0, 300)}`);
    }
    return indexMatch[1];
  }

  /** Poll declaration status; returns UIT when validated. */
  async checkStatus(tenantId: number, uploadId: string): Promise<{ status: string; uit?: string; raw: string }> {
    const token = await this.getAccessToken(tenantId);
    const res = await fetch(`${this.baseUrl}/stareMesaj/${uploadId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`ANAF status check failed (${res.status}) for upload ${uploadId}`);
      return { status: 'UNKNOWN', raw: text };
    }
    const uitMatch = text.match(/UIT[=:"\s]+([0-9A-Z]{10,20})/i);
    const okMatch = /stare="?ok/i.test(text) || uitMatch != null;
    const nokMatch = /stare="?nok/i.test(text);
    return {
      status: nokMatch ? 'REJECTED' : okMatch ? 'CONFIRMED' : 'PENDING',
      uit: uitMatch?.[1],
      raw: text,
    };
  }
}
