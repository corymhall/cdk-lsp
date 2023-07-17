import { createLspConnection } from './lsp-connection.js';

// new Command('cdk-language-server')
//   .version('0.0.0')
//   .parse(process.argv);

createLspConnection({}).listen();
