import {
  Patch,
  ResourceIdentifier,
  TEXT_TURTLE,
  Conditions,
  PassthroughStore,
  PatchHandler,
  ChangeMap,
  ResourceStore,
  readableToString,
  BasicRepresentation,
  NotImplementedHttpError,
  ConflictHttpError
} from '@solid/community-server';
import { graph, parse, serialize } from 'rdflib';
import { parsePatchDocument } from './patch/n3-patch-parser';
import { debug } from '../util/debug';

export class PatchRequiresTurtlePreservationError {};

// Patch parsers by request body content type
const PATCH_PARSERS = {
  'text/n3': parsePatchDocument
};

/**
 * {@link ResourceStore} using decorator pattern for the `modifyResource` function.
 * If the original store supports the {@link Patch}, behaviour will be identical,
 * otherwise the {@link PatchHandler} will be called instead.
 */
export class RdfPatchingStore<T extends ResourceStore = ResourceStore> extends PassthroughStore<T> {
  private readonly patchHandler: PatchHandler;
  protected source: T;

  public constructor(source: T, patchHandler: PatchHandler) {
    super(source);
    this.source = source;
    this.patchHandler = patchHandler;
  }

  public async modifyResource(
    identifier: ResourceIdentifier,
    patch: Patch,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    try {
      debug('trying this.source.modifyResource');
      return await this.source.modifyResource(identifier, patch, conditions);
    } catch (error: unknown) {
      if (NotImplementedHttpError.isInstance(error)) {
        try {
          debug('trying this.patchHandler.handleSafe');
          const result = await this.patchHandler.handleSafe({ source: this.source, identifier, patch });
          return result;
        } catch (nestedError: unknown) {
          // console.log('inner error', nestedError);
          if (nestedError instanceof PatchRequiresTurtlePreservationError) {
            debug('trying this.modifyResourceUsingRdfLib');
            return this.modifyResourceUsingRdflib(identifier, patch, conditions);
          }
        }
      }
      throw error;
    }
  }
  private async modifyResourceUsingRdflib(
    identifier: ResourceIdentifier,
    patch: Patch,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const store = graph();
    const patchStr = await readableToString(patch.data);
    const resourceUrl = identifier.path;
    const resourceSym = store.sym(resourceUrl);
    const resourceContentType = TEXT_TURTLE;
    let representation = await this.source.getRepresentation(identifier, { type: { [TEXT_TURTLE]: 1 }});
    const turtle: string = await readableToString(representation.data);
    parse(turtle, store, resourceUrl, resourceContentType);
    const parsePatch = PATCH_PARSERS['text/n3'];
    const patchObject = await parsePatch(resourceUrl, resourceUrl, patchStr);
    try {

      await new Promise((resolve, reject) => {
        (store as any).applyPatch(patchObject, resourceSym, (err: Error | null): void => {
          if (err) {
            reject(err);
          }
          resolve(undefined);
        });
      });
    } catch (e) {
      debug(`RDFLIB PATCH ERROR ${JSON.stringify(e)}`);
      if (JSON.stringify(e as any).startsWith('\"No match found to be patched')) {
        debug('RDFLIB NO MATCH');        
        throw new ConflictHttpError('The document does not contain any matches for the N3 Patch solid:where condition.');
      }
      throw e;
    }
    let serialized: string | undefined = await new Promise((resolve, reject) => {
      serialize(resourceSym, store as any, resourceUrl, resourceContentType, (err: Error | null | undefined, result: string | undefined): void => {
        if (err) {
          reject(err);
        }
        resolve(result);
      });
    });
    if (typeof serialized !== 'string') {
      console.log('something went wrong');
      serialized = turtle;
    }
    representation = new BasicRepresentation(serialized, representation.metadata, TEXT_TURTLE);

    return this.source.setRepresentation(identifier, representation);
  }
}
