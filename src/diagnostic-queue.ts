import debounce from 'p-debounce';
import * as lsp from 'vscode-languageserver';
import { LspDocuments } from './documents.js';
import { pathToUri } from './protocol-translation.js';

class FileDiagnostics {

  protected readonly firePublishDiagnostics = debounce(() => {
    const diagnostics = this.getDiagnostics();
    this.publishDiagnostics({ uri: this.uri, diagnostics });
  }, 50);

  private readonly diagnostics = new Set<lsp.Diagnostic>();

  constructor(
    protected readonly uri: string,
    protected readonly publishDiagnostics: (params: lsp.PublishDiagnosticsParams) => void,
    protected readonly documents: LspDocuments,
  ) { }

  update(diagnostics: lsp.Diagnostic[]): void {
    diagnostics.forEach(diag => this.diagnostics.add(diag));
    void this.firePublishDiagnostics();
  }

  public getDiagnostics(): lsp.Diagnostic[] {
    return Array.from(this.diagnostics);
  }
}

export class DiagnosticEventQueue {
  protected readonly diagnostics = new Map<string, FileDiagnostics>();

  constructor(
    protected readonly publishDiagnostics: (params: lsp.PublishDiagnosticsParams) => void,
    protected readonly documents: LspDocuments,
  ) { }

  updateDiagnostics(file: string, diagnostics: lsp.Diagnostic[]): void {
    const uri = pathToUri(file, this.documents);
    const diagnosticsForFile = this.diagnostics.get(uri) || new FileDiagnostics(uri, this.publishDiagnostics, this.documents);
    diagnosticsForFile.update(diagnostics);
    this.diagnostics.set(uri, diagnosticsForFile);
  }

  public getDiagnosticsForFile(file: string): lsp.Diagnostic[] {
    const uri = pathToUri(file, this.documents);
    return this.diagnostics.get(uri)?.getDiagnostics() || [];
  }
}
