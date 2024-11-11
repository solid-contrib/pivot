// TODO: when version 6 is released:

// import  { extendVocabulary } from "@solid/community-server"

// extendVocabulary(TODO:)
import  { createUriAndTermNamespace } from "@solid/community-server"

export const SH = createUriAndTermNamespace('http://www.w3.org/ns/shacl#',
  'targetClass',
);


export const LDP = createUriAndTermNamespace('http://www.w3.org/ns/ldp#',
  'contains',

  'BasicContainer',
  'Container',
  'Resource',
  'constrainedBy',
);
