import {
  getLoggerFor,
  HttpResponse,
  isInternalContentType,
  NotImplementedHttpError,
  pipeSafely,
  MetadataWriter,
  ResponseDescription,
  ResponseWriter
} from '@solid/community-server';

/**
 * Writes to an {@link HttpResponse} based on the incoming {@link ResponseDescription}.
 */
export class PivotResponseWriter extends ResponseWriter {
  protected readonly logger = getLoggerFor(this);
  private readonly metadataWriter: MetadataWriter;

  public constructor(metadataWriter: MetadataWriter) {
    super();
    this.metadataWriter = metadataWriter;
  }

  public async canHandle(input: { response: HttpResponse; result: ResponseDescription }): Promise<void> {
    const contentType = input.result.metadata?.contentType;
    if (isInternalContentType(contentType)) {
      throw new NotImplementedHttpError(`Cannot serialize the internal content type ${contentType}`);
    }
  }

  public async handle(input: { response: HttpResponse; result: ResponseDescription }): Promise<void> {
    if (input.result.metadata) {
      await this.metadataWriter.handleSafe({ response: input.response, metadata: input.result.metadata });
    }
    console.log('writing response head', input.result.statusCode);
    input.response.writeHead(input.result.statusCode);

    if (input.result.data) {
      const pipe = pipeSafely(input.result.data, input.response);
      pipe.on('error', (error): void => {
        this.logger.error(`Aborting streaming response because of server error; headers already sent.`);
        this.logger.error(`Response error: ${error.message}`);
      });
    } else {
      // If there is input data the response will end once the input stream ends
      input.response.end();
    }
  }
}
