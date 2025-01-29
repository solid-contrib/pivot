import { IncomingMessage } from 'http';
import {
  HttpResponse,
  ResponseDescription,
  BasicResponseWriter,
  MetadataWriter,
  TargetExtractor,
  HttpRequest,
  DataAccessorBasedStore
} from '@solid/community-server';

function hasTrailingSlash(input: string): boolean {
  return (input.slice(-1) === '/');
}

function addTrailingSlash(input: string): string {
  return `${input}/`;
}
  
export class PivotResponseWriter extends BasicResponseWriter {
  private readonly store;
  private readonly targetExtractor;
  constructor(metadataWriter: MetadataWriter, store: DataAccessorBasedStore, targetExtractor: TargetExtractor) {
    super(metadataWriter);
    this.store = store;
    this.targetExtractor = targetExtractor;
  }
  public async handle(input: { response: HttpResponse; result: ResponseDescription }): Promise<void> {
    try {
      if (
        (input.response.req.method === 'GET') &&
        (typeof input.response.req.url === 'string') &&
        ([401, 403, 404].indexOf(input.result.statusCode) !== -1) &&
        (hasTrailingSlash(input.response.req.url) === false)) {
        const target = await this.targetExtractor.handleSafe({ request: input.response.req as HttpRequest });
        const withSlash = addTrailingSlash(target.path);
        let exists = false;
        try {
           exists = await this.store.hasResource({ path: withSlash });
        } catch (e) {
           // leave as false
        }
        // console.log('exists', withSlash, exists);
        if (exists) {
          // console.log('rewriting', input.response.req.method, input.response.req.url, input.result.statusCode);
          input.response.statusCode = 301;
          input.response.setHeader('Location', withSlash);
          input.response.end('Try adding a slash at the end of the URL.\n');
          return;
        }
      }
    } catch (e) {
        console.error(e);
    }
    return super.handle(input);
  }
}
