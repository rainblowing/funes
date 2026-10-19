// wrangler.jsonc's `rules` bundle *.yaml as Text modules: the import is the file's text.
declare module "*.yaml" {
  const text: string;
  export default text;
}
