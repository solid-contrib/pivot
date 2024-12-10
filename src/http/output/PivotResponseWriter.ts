import { IncomingMessage } from 'http';
import {
  HttpResponse,
  ResponseDescription,
  BasicResponseWriter
} from '@solid/community-server';

function hasTrailingSlash(input: string): boolean {
  return (input.slice(-1) === '/');
}

function addTrailingSlash(input: string): string {
  return `${input}/`;
}
  
export class PivotResponseWriter extends BasicResponseWriter {
  public async handle(input: { response: HttpResponse; result: ResponseDescription }): Promise<void> {
    try {
        if (
          (input.response.req.method === 'GET') &&
          (typeof input.response.req.url === 'string') &&
          ([401, 403, 404].indexOf(input.result.statusCode) !== -1) &&
          (hasTrailingSlash(input.response.req.url) === false)) {
          console.log('rewriting', input.response.req.method, input.response.req.url, input.result.statusCode);
          input.result.statusCode = 301;
          input.response.setHeader('Location', addTrailingSlash(input.response.req.url));
        }
    } catch (e) {
        console.error(e);
    }
    return super.handle(input);
  }
}
