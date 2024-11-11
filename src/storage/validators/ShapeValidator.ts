import type { Representation } from '@solid/community-server';
import { AsyncHandler } from '@solid/community-server';

export type ShapeValidatorInput = {
  /**
   * The representation of the parent resource.
   * This representation is used to retrieve the shape URL, when it exists.
   */
  parentRepresentation: Representation;
  /**
   * The representation of a resource that might get validated against a shape.
   */
  representation: Representation;
};

/**
 * Interface to validate the representation of a resource against a shape.
 *
 * The class must only handle the shape validation if its parent container has the following triple in its description resource:
 * `<{parentContainerURL}> <ldp:constrainedBy> <{shapeURL}> .`
 */
export abstract class ShapeValidator extends AsyncHandler<ShapeValidatorInput> {}
