// Worker bundler imports *.md files as string content via the
// wrangler.jsonc `rules` block (type: "Text"). This declaration
// teaches the TypeScript compiler the same trick so `import x from
// "./foo.md"` typechecks.
declare module "*.md" {
  const content: string;
  export default content;
}

// *.png files bundle in as an ArrayBuffer via the wrangler.jsonc `rules`
// block (type: "Data"). Same trick, binary payload — used for the OG card.
declare module "*.png" {
  const content: ArrayBuffer;
  export default content;
}
