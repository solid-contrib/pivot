const {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");

const distributionPath = join(__dirname, "..", "dist");
const contextPath = join(distributionPath, "components", "context.jsonld");
const cssContextPath = join(
  __dirname,
  "..",
  "node_modules",
  "@solid",
  "community-server",
  "dist",
  "components",
  "context.jsonld",
);
const cssUrnPrefix = "urn:npm:@solid/community-server:";
const npmBundlePrefix =
  "https://linkedsoftwaredependencies.org/bundles/npm/";

function removeEmptyTerms(value) {
  if (Array.isArray(value)) {
    return value.map(removeEmptyTerms);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key.length > 0)
        .map(([key, entry]) => [key, removeEmptyTerms(entry)]),
    );
  }
  return value;
}

function jsonLdFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return jsonLdFiles(path);
    }
    return path.endsWith(".jsonld") ? [path] : [];
  });
}

// componentsjs-generator 3.x can emit an empty alias for a constructor
// parameter. Empty JSON-LD terms are invalid and make Components.js reject the
// package before it can compile any server configuration.
const context = JSON.parse(readFileSync(contextPath, "utf8"));
writeFileSync(
  contextPath,
  `${JSON.stringify(removeEmptyTerms(context), null, 2)}\n`,
);

// An npm alias installs @jeswr/community-solid-server at
// node_modules/@solid/community-server. The component generator notices the
// package.json name mismatch and emits non-component `urn:npm:` placeholders
// for imported CSS types. Resolve those placeholders through the installed CSS
// context so Pivot's metadata retains CSS's canonical component identifiers.
const cssContext = JSON.parse(readFileSync(cssContextPath, "utf8"))["@context"];
const cssTerms = cssContext.find(
  (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
);
if (!cssTerms) {
  throw new Error(`No component terms found in ${cssContextPath}`);
}

function resolveCssReferences(value) {
  if (Array.isArray(value)) {
    return value.map(resolveCssReferences);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveCssReferences(entry),
      ]),
    );
  }
  if (typeof value === "string" && value.startsWith(cssUrnPrefix)) {
    const term = value.slice(cssUrnPrefix.length);
    const identifier = cssTerms[term]?.["@id"];
    if (typeof identifier !== "string") {
      throw new Error(`Unable to resolve CSS component term ${term}`);
    }
    return identifier.replace(/^npmd:/u, npmBundlePrefix);
  }
  return value;
}

for (const file of jsonLdFiles(distributionPath)) {
  const source = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(
    file,
    `${JSON.stringify(resolveCssReferences(source), null, 2)}\n`,
  );
}
