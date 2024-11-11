import { DataFactory } from 'n3';
import type { AuxiliaryStrategy } from '@solid/community-server';
import {BasicRepresentation, RDF} from '@solid/community-server';
import type { Representation } from '@solid/community-server';
import { RepresentationMetadata } from '@solid/community-server';
import type { ResourceIdentifier } from '@solid/community-server';
import type { RepresentationConverter } from '@solid/community-server';
import { ShaclValidator } from '../../../../src/storage/validators/ShaclValidator';
import type { ShapeValidatorInput } from '../../../../src/storage/validators/ShapeValidator';
import { INTERNAL_QUADS } from '@solid/community-server';
import { BadRequestHttpError } from '@solid/community-server';
import { NotImplementedHttpError } from '@solid/community-server';
import { fetchDataset } from '@solid/community-server';
import { guardedStreamFrom } from '@solid/community-server';
import { LDP, SH } from '../../../../src/util/Vocabularies';
import { SimpleSuffixStrategy } from '../../../util/SimpleSuffixStrategy';
const { namedNode, quad, literal } = DataFactory;

jest.mock('@solid/community-server/dist/util/FetchUtil', (): any => ({
  fetchDataset: jest.fn<string, any>(),
}));

describe('ShaclValidator', (): void => {
  const root = 'http://example.org/';
  const shapeUrl = `${root}shape`;
  const auxiliarySuffix = '.dummy';
  let shape: Representation;
  let parentRepresentation: Representation;
  let representationToValidate: Representation;
  let converter: RepresentationConverter;
  let validator: ShaclValidator;
  let auxiliaryStrategy: AuxiliaryStrategy;
  let input: ShapeValidatorInput;

  beforeEach((): void => {
    const containerMetadata: RepresentationMetadata = new RepresentationMetadata({ path: root });
    containerMetadata.addQuad(namedNode(root), LDP.terms.constrainedBy, namedNode(shapeUrl));
    parentRepresentation = new BasicRepresentation();
    parentRepresentation.metadata = containerMetadata;
    representationToValidate = new BasicRepresentation(guardedStreamFrom([
      quad(namedNode('http://example.org/a'), RDF.terms.type, namedNode('http://example.org/c')),
      quad(namedNode('http://example.org/a'), namedNode('http://xmlns.com/foaf/0.1/name'), literal('Test')),
    ]), INTERNAL_QUADS);

    const shapeIdentifier: ResourceIdentifier = { path: `${shapeUrl}` };
    shape = new BasicRepresentation(guardedStreamFrom([
      quad(namedNode('http://example.org/exampleshape'), RDF.terms.type, namedNode('http://www.w3.org/ns/shacl#NodeShape')),
      quad(namedNode('http://example.org/exampleshape'), SH.terms.targetClass, namedNode('http://example.org/c')),
      quad(namedNode('http://example.org/exampleshape'), namedNode('http://www.w3.org/ns/shacl#property'), namedNode('http://example.org/property')),
      quad(namedNode('http://example.org/property'), namedNode('http://www.w3.org/ns/shacl#path'), namedNode('http://xmlns.com/foaf/0.1/name')),
      quad(namedNode('http://example.org/property'), namedNode('http://www.w3.org/ns/shacl#minCount'), literal(1)),
      quad(namedNode('http://example.org/property'), namedNode('http://www.w3.org/ns/shacl#maxCount'), literal(1)),
      quad(namedNode('http://example.org/property'), namedNode('http://www.w3.org/ns/shacl#datatype'), namedNode('http://www.w3.org/2001/XMLSchema#string')),
    ]), shapeIdentifier, INTERNAL_QUADS);

    converter = {
      handleSafe: jest.fn((): Promise<Representation> => Promise.resolve(representationToValidate)),
      canHandle: jest.fn(),
      handle: jest.fn(),
    };

    auxiliaryStrategy = new SimpleSuffixStrategy(auxiliarySuffix);
    validator = new ShaclValidator(converter, auxiliaryStrategy);

    input = {
      parentRepresentation,
      representation: representationToValidate,
    };
    (fetchDataset as jest.Mock).mockReturnValue(Promise.resolve(shape));
  });

  afterEach((): void => {
    jest.clearAllMocks();
  });


  it('does not validate when the parent container is not constrained by a shape.', async(): Promise<void> => {
    input.parentRepresentation = new BasicRepresentation();
    await expect(validator.handleSafe(input)).resolves.toBeUndefined();
    expect(converter.handleSafe).toHaveBeenCalledTimes(0);
    expect(fetchDataset).toHaveBeenCalledTimes(0);
  });

  it('does not validate when the representation is empty.', async(): Promise<void> => {
    input.representation = new BasicRepresentation()
    await expect(validator.handleSafe(input)).resolves.toBeUndefined();
    expect(converter.handleSafe).toHaveBeenCalledTimes(0);
    expect(fetchDataset).toHaveBeenCalledTimes(0);
  });

  it('fetches the shape and validates the representation.', async(): Promise<void> => {
    await expect(validator.handleSafe(input)).resolves.toBeUndefined();
    expect(converter.handleSafe).toHaveBeenCalledTimes(1);
    expect(fetchDataset).toHaveBeenCalledTimes(1);
    expect(fetchDataset).toHaveBeenLastCalledWith(shapeUrl);
  });

  it('throws error when the converter fails.', async(): Promise<void> => {
    const error = new BadRequestHttpError('error');
    converter.handleSafe = jest.fn().mockImplementation((): void => {
      throw error;
    });
    await expect(validator.handleSafe(input)).rejects.toThrow(error);
  });

  it('throws error when the converter fails due to non-RDF input to validate.', async(): Promise<void> => {
    converter.handleSafe = jest.fn().mockImplementationOnce((): void => {
      throw new NotImplementedHttpError('error');
    });
    await expect(validator.handleSafe(input)).rejects.toThrow(BadRequestHttpError);
  });


  it('does not execute validation when the target resource is an auxiliary resource.', async(): Promise<void> => {
    input.representation.metadata.identifier = namedNode(root + auxiliarySuffix);

    await expect(validator.handleSafe(input)).resolves.toBeUndefined();
  });

  it('throws error when the data does not conform to the shape.', async(): Promise<void> => {
    converter.handleSafe = jest.fn((): Promise<Representation> => Promise.resolve(
      new BasicRepresentation(guardedStreamFrom([
        quad(namedNode('http://example.org/a'), RDF.terms.type, namedNode('http://example.org/c')),
        quad(namedNode('http://example.org/a'), namedNode('http://xmlns.com/foaf/0.1/name'), literal(5)),
      ]), INTERNAL_QUADS),
    ));

    await expect(validator.handleSafe(input)).rejects.toThrow(BadRequestHttpError);
    expect(converter.handleSafe).toHaveBeenCalledTimes(1);
    expect(fetchDataset).toHaveBeenCalledTimes(1);
    expect(fetchDataset).toHaveBeenLastCalledWith(shapeUrl);
  });

  it('throws error when no nodes not conform to any of the target classes of the shape.', async(): Promise<void> => {
    converter.handleSafe = jest.fn((): Promise<Representation> => Promise.resolve(
      new BasicRepresentation(guardedStreamFrom([
        quad(namedNode('http://example.org/a'), namedNode('http://xmlns.com/foaf/0.1/name'), literal('Test')),
      ]), INTERNAL_QUADS),
    ));

    await expect(validator.handleSafe(input)).rejects.toThrow(BadRequestHttpError);
    expect(converter.handleSafe).toHaveBeenCalledTimes(1);
    expect(fetchDataset).toHaveBeenCalledTimes(1);
    expect(fetchDataset).toHaveBeenLastCalledWith(shapeUrl);
  });
});
