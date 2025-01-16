import type { HttpHandlerInput, ResponseWriter,RedirectHttpError } from '@solid/community-server';
import { ResponseDescription, SOLID_HTTP, getLoggerFor, HttpHandler, MovedPermanentlyHttpError } from '@solid/community-server';
import { DataFactory } from 'n3';

class RedirectResponseDescription extends ResponseDescription {
  public constructor(error: RedirectHttpError) {
    error.metadata.set(SOLID_HTTP.terms.location, DataFactory.namedNode(error.location));
    super(error.statusCode, error.metadata);
  }
}

/**
 * HTTP handler that redirects all requests to the OIDC library.
 */
export class PivotOidcHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);

  public constructor(private readonly baseUrl: string, private readonly responseWriter: ResponseWriter) {
    super();
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const redirect = `${this.baseUrl}.well-known/openid-configuration`
    this.logger.info(`Redirecting ${request.url} to ${redirect}`);
    const redirectError = new MovedPermanentlyHttpError(redirect);
    const result = new RedirectResponseDescription(redirectError);
    await this.responseWriter.handleSafe({ response, result });
  }
}
