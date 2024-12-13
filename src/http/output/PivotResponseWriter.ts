import { IncomingMessage } from 'http';
import {
  HttpResponse,
  ResponseDescription,
  BasicResponseWriter,
  MetadataWriter,
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
  constructor(metadataWriter: MetadataWriter, store: DataAccessorBasedStore) {
    super(metadataWriter);
    this.store = store;
  }
  public async handle(input: { response: HttpResponse; result: ResponseDescription }): Promise<void> {
    try {
        if (
          (input.response.req.method === 'GET') &&
          (typeof input.response.req.url === 'string') &&
          ([401, 403, 404].indexOf(input.result.statusCode) !== -1) &&
          (hasTrailingSlash(input.response.req.url) === false)) {
          const withSlash = addTrailingSlash(input.response.req.url);
          const exists = await this.store.hasResource({ path: withSlash });
          if (exists) {
            console.log('rewriting', input.response.req.method, input.response.req.url, input.result.statusCode);
            input.result.statusCode = 301;
            input.response.setHeader('Location', withSlash);
          }
        }
    } catch (e) {
        console.error(e);
    }
    return super.handle(input);
  }
}
