import { INestApplication, Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

const anafHttpLogger = new Logger('AnafCompanyHttp');
const httpLogger = new Logger('Http');

export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api', {
    // ANAF redirects the OAuth callback to the registered redirect_uri, which
    // has no /api prefix; serve just this route at the root so the redirect
    // resolves. All other routes stay under /api.
    exclude: [{ path: 'etransport/anaf/callback', method: RequestMethod.GET }],
  });
  app.enableCors({ origin: true, credentials: true });
  app.use(logEveryRequest);
  app.use(logAnafCompanyRequest);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  return app;
}

function logEveryRequest(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const startedAt = Date.now();
  const contentLength = request.header('content-length');
  httpLogger.log(
    `→ ${request.method} ${request.originalUrl} ` +
      `origin=${request.header('origin') ?? '-'} ` +
      `auth=${request.header('authorization') ? 'yes' : 'no'} ` +
      `len=${contentLength ?? '-'}`,
  );
  response.on('finish', () => {
    httpLogger.log(
      `← ${request.method} ${request.originalUrl} ${response.statusCode} ${Date.now() - startedAt}ms`,
    );
  });
  next();
}

function logAnafCompanyRequest(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  if (!request.originalUrl.startsWith('/api/accounting/company/anaf/')) {
    next();
    return;
  }

  const requestId = validRequestId(request.header('x-request-id'))
    ? request.header('x-request-id')!
    : randomUUID();
  const startedAt = Date.now();
  let finished = false;

  request.headers['x-request-id'] = requestId;
  response.setHeader('x-request-id', requestId);
  anafHttpLogger.log(
    JSON.stringify({
      event: 'request_received',
      requestId,
      method: request.method,
      path: request.originalUrl,
      hasAuthorization: Boolean(request.header('authorization')),
      origin: request.header('origin') ?? null,
      userAgent: request.header('user-agent')?.slice(0, 160) ?? null,
    }),
  );

  response.on('finish', () => {
    finished = true;
    anafHttpLogger.log(
      JSON.stringify({
        event: 'response_finished',
        requestId,
        method: request.method,
        path: request.originalUrl,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  });
  response.on('close', () => {
    if (finished) return;
    anafHttpLogger.warn(
      JSON.stringify({
        event: 'connection_closed_before_response',
        requestId,
        method: request.method,
        path: request.originalUrl,
        durationMs: Date.now() - startedAt,
      }),
    );
  });

  next();
}

function validRequestId(value?: string): value is string {
  return Boolean(value && /^[a-zA-Z0-9._-]{1,100}$/.test(value));
}
