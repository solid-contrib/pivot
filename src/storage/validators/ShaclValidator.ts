import type {AuxiliaryStrategy, RepresentationConverter} from '@solid/community-server';
import {
  BadRequestHttpError,
  BasicRepresentation,
  cloneRepresentation,
  fetchDataset,
  getLoggerFor,
  INTERNAL_QUADS,
  NotImplementedHttpError,
  readableToQuads
} from '@solid/community-server';
import type {Store} from 'n3';
import SHACLValidator from 'rdf-validate-shacl';
import {LDP, SH} from '../../util/Vocabularies';
import type {ShapeValidatorInput} from './ShapeValidator';
import {ShapeValidator} from './ShapeValidator';

/**
 * Validates a Representation against SHACL shapes using an external SHACL validator.
 */
export class ShaclValidator extends ShapeValidator {
  private readonly converter: RepresentationConverter;
  protected readonly logger = getLoggerFor(this);
  private readonly auxiliaryStrategy: AuxiliaryStrategy;

  public constructor(converter: RepresentationConverter, auxiliaryStrategy: AuxiliaryStrategy) {
    super();
    this.converter = converter;
    this.auxiliaryStrategy = auxiliaryStrategy;
  }

  public async canHandle({ parentRepresentation, representation }: ShapeValidatorInput): Promise<void> {
    if (this.auxiliaryStrategy.isAuxiliaryIdentifier({ path: representation.metadata.identifier.value })) {
      throw new NotImplementedHttpError('No shape validation executed on auxiliary files.');
    }

    const shapeURL = parentRepresentation.metadata.get(LDP.terms.constrainedBy)?.value;
    if (!shapeURL) {
      throw new NotImplementedHttpError('No ldp:constrainedBy predicate.');
    }

    if (representation.isEmpty) {
      throw new BadRequestHttpError('Data could not be validated as it could not be converted to rdf');
    }
  }

  public async handle(input: ShapeValidatorInput): Promise<void> {
    const { parentRepresentation, representation } = input;
    const shapeURL = parentRepresentation.metadata.get(LDP.terms.constrainedBy)!.value;

    // Convert the RDF representation to a N3.Store
    let representationData: BasicRepresentation;
    const preferences = { type: { [INTERNAL_QUADS]: 1 }};
    try {
      // Creating a new representation as the data might be written later by DataAccessorBasedStore
      const tempRepresentation = await cloneRepresentation(representation);
      this.logger.debug(`resource to be validated by the shape: ${representation.metadata.identifier.value}`);
      representationData = await this.converter.handleSafe({
        identifier: { path: representation.metadata.identifier.value },
        representation: tempRepresentation,
        preferences,
      });
    } catch (error: unknown) {
      representation.data.destroy();
      if (NotImplementedHttpError.isInstance(error)) {
        throw new BadRequestHttpError('Data could not be validated as it could not be converted to rdf',
          { details: { ...error, message: error.message }});
      }
      throw error;
    }
    const dataStore = await readableToQuads(representationData.data);

    this.logger.debug(`URL of the shapefile present in the metadata of the parent: ${shapeURL}`);
    const shape = await fetchDataset(shapeURL);
    const shapeStore = await readableToQuads(shape.data);
    this.targetClassCheck(shapeStore, dataStore, shapeURL);
    // Actual validation
    const validator = new SHACLValidator(shapeStore);
    const report = validator.validate(dataStore);
    this.logger.debug(`Validation of the data: ${report.conforms ? 'success' : 'failure'}`);
    if (!report.conforms) {
      throw new BadRequestHttpError(`Data does not conform to ${shapeURL}`);
    }
  }

  public async handleSafe(input: ShapeValidatorInput): Promise<void> {
    let canHandle: boolean;
    try {
      await this.canHandle(input);
      canHandle = true;
    } catch {
      canHandle = false;
    }
    if (canHandle) {
      await this.handle(input);
    }
  }

  /**
   * Verifies that there is at least a triple with a type that corresponds to a target class.
   * Throws an error when that is not present.
   *
   * NOTE: it is possible to validate without targetClass and use one of the other target declarations,
   * but those are used less often.
   *
   * @param shapeStore - The N3.Store containing the shapes
   * @param dataStore - The N3.Store containing the data to be posted
   * @param shapeURL - The URL of where the shape is posted
   */
  private targetClassCheck(shapeStore: Store, dataStore: Store, shapeURL: string): void {
    // Find if any of the sh:targetClass are present
    const targetClasses = shapeStore.getObjects(null, SH.targetClass, null);
    let targetClassesPresent = targetClasses.some(targetClass => dataStore.countQuads(null, null, targetClass, null) > 0);
    if (!targetClassesPresent) {
      throw new BadRequestHttpError(`Data not accepted as no nodes in the body conform to any of the target classes of ${shapeURL}`);
    }
  }
}
