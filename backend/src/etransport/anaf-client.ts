import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';

const TOKEN_SAFETY_WINDOW_MS = 5 * 60 * 1000;

/**
 * ANAF's /upload endpoint returns validation failures as HTTP 200 with a JSON
 * body `{ Errors: [{ errorMessage }], ExecutionStatus: 1, trace_id }`. Surface
 * the full error text (every message) so Schematron rules like BR-207 aren't cut
 * off mid-sentence; fall back to a generous raw slice for non-JSON responses.
 */
function describeAnafResponse(text: string): string {
  try {
    const body = JSON.parse(text);
    const errors = Array.isArray(body?.Errors) ? body.Errors : [];
    const messages = errors
      .map((e: { errorMessage?: string }) => e?.errorMessage)
      .filter((m: unknown): m is string => typeof m === 'string' && m.trim() !== '');
    if (messages.length) {
      const trace = body?.trace_id ? ` (trace_id: ${body.trace_id})` : '';
      return `${messages.join(' | ')}${trace}`;
    }
  } catch {
    // Not JSON — fall through to the raw slice below.
  }
  return text.slice(0, 1000);
}

/** Accept both ANAF's JSON upload receipt and its older XML-like response. */
export function parseAnafUploadIndex(text: string): string | undefined {
  try {
    const body = JSON.parse(text);
    const rawIndex = body?.index_incarcare;
    const index = String(rawIndex ?? '').trim();
    if (/^\d+$/.test(index)) return index;
  } catch {
    // Not JSON — try the legacy response syntax below.
  }

  return text.match(/index_incarcare["']?\s*(?:=|:)\s*["']?(\d+)/i)?.[1];
}

export function parseAnafStatusResponse(
  text: string,
): { status: 'CONFIRMED' | 'REJECTED' | 'PENDING'; uit?: string } {
  let state = '';
  let uit: string | undefined;
  try {
    const body = JSON.parse(text);
    state = String(body?.stare ?? body?.status ?? '').trim().toLowerCase();
    const rawUit = String(body?.UIT ?? body?.uit ?? '').trim().toUpperCase();
    if (/^[0-9A-Z]{10,20}$/.test(rawUit)) uit = rawUit;
  } catch {
    // Not JSON — retain compatibility with the older text/XML response.
    state = text.match(/stare["']?\s*(?:=|:)\s*["']?([^"'\s,}]+)/i)?.[1]?.toLowerCase() ?? '';
    uit = text.match(/UIT["']?\s*(?:=|:)\s*["']?([0-9A-Z]{10,20})/i)?.[1];
  }

  if (/^(?:nok|rejected|respins)/.test(state)) return { status: 'REJECTED' };
  if (uit || /^(?:ok|valid|validated|confirmed)/.test(state)) {
    return { status: 'CONFIRMED', uit };
  }
  return { status: 'PENDING' };
}

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

  private get redirectUri(): string {
    return (this.config.get<string>('ANAF_REDIRECT_URI') ?? '').trim();
  }

  /**
   * Build the logincert.anaf.ro authorize URL the browser must open. The
   * qualified certificate is presented there (in the browser), so this only
   * returns the URL — the frontend performs the top-level redirect.
   */
  buildAuthorizeUrl(state: string): string {
    if (!this.configured) {
      throw new BadRequestException(
        'Integrarea ANAF nu este configurată. Setează ANAF_CLIENT_ID/ANAF_CLIENT_SECRET.',
      );
    }
    if (!this.redirectUri) {
      throw new BadRequestException(
        'ANAF_REDIRECT_URI nu este setat. Trebuie să fie identic cu URI-ul înregistrat în portalul ANAF.',
      );
    }
    const authorizeUrl = this.config.get(
      'ANAF_AUTHORIZE_URL',
      'https://logincert.anaf.ro/anaf-oauth2/v1/authorize',
    );
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.get('ANAF_CLIENT_ID', ''),
      redirect_uri: this.redirectUri,
      token_content_type: 'jwt',
      state,
    });
    return `${authorizeUrl}?${params.toString()}`;
  }

  /** Exchange the authorization code for tokens and store them for the tenant. */
  async connectWithCode(tenantId: number, code: string): Promise<void> {
    if (!this.configured) {
      throw new BadRequestException('Integrarea ANAF nu este configurată.');
    }
    if (!this.redirectUri) {
      throw new BadRequestException('ANAF_REDIRECT_URI nu este setat.');
    }
    const tokenUrl = this.config.get('ANAF_TOKEN_URL', 'https://logincert.anaf.ro/anaf-oauth2/v1/token');
    // ANAF documents "Client Authentication: Send as Basic Auth header".
    const basicAuth = Buffer.from(
      `${this.config.get('ANAF_CLIENT_ID', '')}:${this.config.get('ANAF_CLIENT_SECRET', '')}`,
    ).toString('base64');
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        token_content_type: 'jwt',
      }),
    });
    if (!res.ok) {
      throw new BadRequestException(
        `Schimbul codului ANAF a eșuat (${res.status}): ${(await res.text()).slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const expiresAt = new Date(Date.now() + (data.expires_in ?? 0) * 1000);
    await this.prisma.anafToken.upsert({
      where: { tenantId },
      create: {
        tenantId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? '',
        expiresAt,
      },
      update: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? '',
        expiresAt,
      },
    });
  }

  /** Connection status for the Settings UI. */
  async getConnectionStatus(
    tenantId: number,
  ): Promise<{ configured: boolean; connected: boolean; expiresAt: string | null }> {
    const row = this.configured
      ? await this.prisma.anafToken.findUnique({ where: { tenantId } })
      : null;
    return {
      configured: this.configured,
      connected: Boolean(row),
      expiresAt: row?.expiresAt.toISOString() ?? null,
    };
  }

  async disconnect(tenantId: number): Promise<void> {
    await this.prisma.anafToken.deleteMany({ where: { tenantId } });
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
      // 5xx is an ANAF gateway/server outage, not a rejection of our file. The
      // declaration stays DRAFT (status is only advanced on success), so the
      // user can safely retry once ANAF is back — surface that, don't imply the
      // content was refused.
      if (res.status >= 500) {
        throw new BadRequestException(
          `ANAF este temporar indisponibil (${res.status}). Declarația NU a fost trimisă — reîncearcă în câteva minute.`,
        );
      }
      throw new BadRequestException(`ANAF a respins declarația (${res.status}): ${describeAnafResponse(text)}`);
    }
    const uploadId = parseAnafUploadIndex(text);
    if (!uploadId) {
      throw new BadRequestException(`Răspuns ANAF neașteptat: ${describeAnafResponse(text)}`);
    }
    return uploadId;
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
    const parsed = parseAnafStatusResponse(text);
    return {
      ...parsed,
      raw: text,
    };
  }
}
