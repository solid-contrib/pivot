import { IncomingMessage, ServerResponse } from 'http';
import { AsyncHandler } from '@solid/community-server';

function toggleTrailingSlash(input: string) {
  if (input.slice(-1) === '/') {
    return input.slice(0, input.length - 1);
  }
  return `${input}/`;
}

/**
 * A composite handler that will try to run all supporting handlers sequentially
 * and return the value of the last supported handler.
 * The `canHandle` check of this handler will always succeed.
 */
export class PivotHttpSequenceHandler<TIn = void, TOut = void> extends AsyncHandler<TIn, TOut | undefined> {
  private readonly handlers: AsyncHandler<TIn, TOut>[];

  public constructor(handlers: AsyncHandler<TIn, TOut>[]) {
    super();
    this.handlers = [ ...handlers ];
  }

  public async handle(input: TIn): Promise<TOut | undefined> {
    let result: TOut | undefined;
    for (const handler of this.handlers) {
      let supported: boolean;
      try {
        await handler.canHandle(input);
        supported = true;
      } catch {
        supported = false;
      }
      if (supported) {
        result = await handler.handle(input);
      }
    }
    // try {
    //   const req = ((input as any).request as IncomingMessage);
    //   const res = ((input as any).response as ServerResponse);
    //   if (req.method === 'GET' && [401, 403, 404].indexOf(res.statusCode) !== -1) {
    //     res.setHeader('Location', toggleTrailingSlash(req.url as string));
    //     res.statusCode = 301;
    //   }
    // } catch (e) {
    //   console.error(e);
    // }
    return result;
  }
}
