// The ONE version string. mcp-server.ts advertised a hardcoded "0.1.0" that had already drifted
// from package.json, so a field failure could not be tied back to an artifact. A test pins this to
// the manifest; `funes --version` prints it and the release gate checks it against the tarball.
export const FUNES_VERSION = "0.1.0-alpha.1";
