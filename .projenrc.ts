import { TypeScriptModuleResolution } from 'projen/lib/javascript/index.js';
import { TypeScriptProject } from 'projen/lib/typescript/index.js';
const project = new TypeScriptProject({
  defaultReleaseBranch: 'main',
  name: 'cdk-lsp',
  projenrcTs: true,
  bin: {
    'cdk-language-server': 'bin/cli.mjs',
  },
  autoDetectBin: false,
  deps: [
    'openai',
    'tree-sitter',
    'tree-sitter-typescript',
    'vscode-languageserver-protocol',
    'p-debounce',
    'commander',
    '@aws-cdk/cli-lib-alpha',
    'vscode-uri',
    'aws-cdk-lib@^2.81.0',
    'vscode-languageserver@^8.1.0',
    'vscode-languageserver-textdocument@^1.0.8',
  ],
  devDeps: [
    'esbuild',
    'constructs',
  ],
  tsconfigDev: {
    compilerOptions: {
      target: 'es2020',
      esModuleInterop: true,
      lib: ['es2020'],
      module: 'es2020',
      moduleResolution: TypeScriptModuleResolution.NODE_NEXT,
    },
  },

  // deps: [],                /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
});
project.tsconfig?.addInclude('typings.d.ts');
project.tsconfigDev?.addInclude('typings.d.ts');
project.bundler.addBundle('src/cli.ts', {
  target: 'node2020',
  sourcemap: true,
  externals: ['tree-sitter', 'tree-sitter-typescript'],
  outfile: 'cli.cjs',
  tsconfigPath: 'tsconfig.dev.json',
  platform: 'node',
  loaders: {
    node: 'copy',
  },
});
// TODO: copy over node modules as part of bundle for externals
project.package.addField('type', 'module');
project.defaultTask?.reset();
project.defaultTask?.exec('ts-node --esm --project tsconfig.dev.json .projenrc.ts');
project.synth();
