import debounce from 'p-debounce';
import * as lsp from 'vscode-languageserver/node';
import { Cdk } from './cdk/cdk.js';
import { CdkInitializeParams/* , SupportedFeatures  */ } from './cdk-protocol.js';
import { DiagnosticEventQueue } from './diagnostic-queue.js';
import { LspDocuments } from './documents.js';
import { LspClient } from './lsp-client.js';
import { pathToUri, uriToPath } from './protocol-translation.js';
import { ConstructNapper } from './treesitter.js';

export interface CdkServiceConfiguration {
  lspClient: LspClient;
}
export const Commands = {
  APPLY_WORKSPACE_EDIT: '_cdk.applyWorkspaceEdit',
  APPLY_CODE_ACTION: '_cdk.applyCodeAction',
  APPLY_REFACTORING: '_cdk.applyRefactoring',
  CONFIGURE_PLUGIN: '_cdk.configurePlugin',
  ORGANIZE_IMPORTS: '_cdk.organizeImports',
  APPLY_RENAME_FILE: '_cdk.applyRenameFile',
  APPLY_COMPLETION_CODE_ACTION: '_cdk.applyCompletionCodeAction',
  /** Commands below should be implemented by the client */
  SELECT_REFACTORING: '_cdk.selectRefactoring',
};
export class LspServer {
  // private features: SupportedFeatures = {};
  private initializeParams: CdkInitializeParams | undefined = undefined;
  private _cdk?: Cdk;
  private readonly documents = new LspDocuments();
  private diagnosticQueue?: DiagnosticEventQueue;
  public readonly doRequestDiagnosticsDebounced = debounce(() => this.doRequestDiagnostics(), 200);
  protected diagnosticsTokenSource: lsp.CancellationTokenSource | undefined;
  pendingDebouncedRequest = false;
  constructor(private options: CdkServiceConfiguration) {

  }
  public get cdk(): Cdk {
    if (!this._cdk) throw new Error('CDK Project has not been initialized!');
    return this._cdk;
  }
  async initialize(params: CdkInitializeParams): Promise<lsp.InitializeResult> {

    const root = params.rootUri ? uriToPath(params.rootUri) : params.rootPath || undefined;
    console.error(params, root);
    if (!root) {
      throw new Error('could not find workspace root');
    }

    this._cdk = new Cdk(root);

    this.diagnosticQueue = new DiagnosticEventQueue(
      diagnostics => this.options.lspClient.publishDiagnostics(diagnostics),
      this.documents,
    );

    this.initializeParams = params;
    const clientCapabilities = this.initializeParams.capabilities;
    const initializeResult: lsp.InitializeResult = {
      capabilities: {
        textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
        codeActionProvider: clientCapabilities.textDocument?.codeAction?.codeActionLiteralSupport
          ? {
            codeActionKinds: [
              lsp.CodeActionKind.QuickFix,
              lsp.CodeActionKind.RefactorInline,
              lsp.CodeActionKind.RefactorRewrite,
            ],
          } : true,
        definitionProvider: true,
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        documentHighlightProvider: true,
        documentSymbolProvider: true,
        executeCommandProvider: {
          commands: [
            Commands.APPLY_WORKSPACE_EDIT,
            Commands.APPLY_CODE_ACTION,
            Commands.APPLY_REFACTORING,
            Commands.CONFIGURE_PLUGIN,
            Commands.ORGANIZE_IMPORTS,
            Commands.APPLY_RENAME_FILE,
          ],
        },
        hoverProvider: true,
        inlayHintProvider: true,
        referencesProvider: true,
        selectionRangeProvider: true,
        workspaceSymbolProvider: true,
        implementationProvider: true,
        typeDefinitionProvider: true,
        callHierarchyProvider: true,
        foldingRangeProvider: true,
        workspace: { },
      },
    };
    return initializeResult;
  }
  public initialized(_: lsp.InitializedParams): void {
    // TODO
  }

  protected async interuptDiagnostics<R>(f: () => R): Promise<R> {
    if (!this.diagnosticsTokenSource) {
      return f();
    }
    this.cancelDiagnostics();
    const result = f();
    await this.requestDiagnostics();
    return result;
  }
  // True if diagnostic request is currently debouncing or the request is in progress. False only if there are
  // no pending requests.
  async requestDiagnostics(): Promise<void> {
    this.pendingDebouncedRequest = true;
    await this.doRequestDiagnosticsDebounced();
  }
  protected async doRequestDiagnostics(): Promise<void> {
    this.cancelDiagnostics();
    const geterrTokenSource = new lsp.CancellationTokenSource();
    this.diagnosticsTokenSource = geterrTokenSource;

    const { files } = this.documents;
    try {
      for (const file of files) {
        const diagnostics = await this.cdk.violations(file);
        this.diagnosticQueue?.updateDiagnostics(file, diagnostics);
      }
    } finally {
      if (this.diagnosticsTokenSource === geterrTokenSource) {
        this.diagnosticsTokenSource = undefined;
        this.pendingDebouncedRequest = false;
      }
    }
  }
  protected cancelDiagnostics(): void {
    if (this.diagnosticsTokenSource) {
      this.diagnosticsTokenSource.cancel();
      this.diagnosticsTokenSource = undefined;
    }
  }
  didOpenTextDocument(params: lsp.DidOpenTextDocumentParams): void {
    const file = uriToPath(params.textDocument.uri);
    if (!file) return;
    if (this.documents.open(file, params.textDocument)) {
      this.cancelDiagnostics();
      void this.requestDiagnostics();
    } else {

    }
  }

  didCloseTextDocument(params: lsp.DidCloseTextDocumentParams): void {
    const file = uriToPath(params.textDocument.uri);
    if (!file) {
      return;
    }
    this.closeDocument(file);
  }

  protected closeDocument(file: string): void {
    const document = this.documents.close(file);
    if (!document) {
      return;
    }
    // we won't be updating diagnostics anymore for that file, so clear them
    // so we don't leave stale ones
    this.options.lspClient.publishDiagnostics({
      diagnostics: [],
      uri: file,
    });
  }

  didChangeTextDocument(params: lsp.DidChangeTextDocumentParams): void {
    const { textDocument } = params;
    const file = uriToPath(textDocument.uri);
    if (!file) {
      return;
    }

    const document = this.documents.get(file);
    if (!document) {
      console.error(`Received change on non-opened document ${textDocument.uri}`);
      throw new Error(`Received change on non-opened document ${textDocument.uri}`);
    }

    for (const change of params.contentChanges) {
      document.applyEdit(textDocument.version, change);
      // TODO: should we re-synth?
    }
    this.cancelDiagnostics();
    void this.requestDiagnostics();
  }

  didSaveTextDocument(_params: lsp.DidSaveTextDocumentParams): void {
    // TODO: should we re-synth?
  }

  public async codeAction(params: lsp.CodeActionParams, _token?: lsp.CancellationToken): Promise<lsp.CodeAction[]> {
    const file = uriToPath(params.textDocument.uri);
    if (!file) {
      return [];
    }
    const actions: lsp.CodeAction[] = [];

    if (!this.pendingDebouncedRequest) {
      const diagnostics = this.diagnosticQueue?.getDiagnosticsForFile(file) || [];
      if (diagnostics.length) {
        const napper = new ConstructNapper();
        const diagActions = await Promise.all(diagnostics.map(diag => {
          const doc = this.documents.get(file);
          const docEnd = doc?.getFullRange().end;
          const text = doc?.getText({
            start: diag.range.start,
            end: docEnd!,
          });
          return napper.getCodeFixForConstruct(text!, diag.range, params.textDocument.uri, diag);
        }));
        actions.push(...(diagActions.filter(action => !!action) as lsp.CodeAction[]));
      }
    }
    return actions;
  }

  // async prepareTypeHierarchy(params: lsp.TypeHierarchyPrepareParams, _token?: lsp.CancellationToken): Promise<lsp.TypeHierarchyItem[] | null> {
  //   const file = uriToPath(params.textDocument.uri);
  //   console.error('prepareCallHierarchy called!');
  //   if (!file) {
  //     return null;
  //   }
  //   return this.getTypeHierarchyItems(file, params.position);
  // }

  // async typeHierarchySubtypes(params: lsp.TypeHierarchySubtypesParams, _token?: lsp.CancellationToken): Promise<lsp.TypeHierarchyItem[] | null> {
  //   const file = uriToPath(params.item.uri);
  //   console.error('typeHierarchySubtypes called!');
  //   if (!file) {
  //     return null;
  //   }
  //   return this.getTypeHierarchyItems(file, params.item.range.start);
  // }

  getLocationLinks(uri: string, position: lsp.Position): lsp.LocationLink[] | undefined {
    const uriGenerator = (filePath: string): string => {
      const newPath = pathToUri(filePath, this.documents);
      return newPath;
    };
    const start = position;
    const nodeTree = this.cdk.getNodeResources(uri, {
      character: start.character,
      line: start.line,
    }, uriGenerator);
    return nodeTree;
  }


  async implementation(params: lsp.TextDocumentPositionParams, _token?: lsp.CancellationToken): Promise<lsp.LocationLink[] | undefined> {
    const file = uriToPath(params.textDocument.uri);
    if (!file) {
      return [];
    }
    return this.getLocationLinks(file, params.position);
  }

  async prepareCallHierarchy(params: lsp.CallHierarchyPrepareParams, _token?: lsp.CancellationToken): Promise<lsp.CallHierarchyItem[] | null> {
    const file = uriToPath(params.textDocument.uri);
    console.error('prepareCallHierarchy called!');
    if (!file) {
      return null;
    }
    const uriGenerator = (filePath: string): string => {
      const newPath = pathToUri(filePath, this.documents);
      return newPath;
    };
    const start = params.position;
    const nodeTree = this.cdk.getNodeTree(file, {
      character: start.character,
      line: start.line,
    }, uriGenerator);
    return nodeTree;
  }

  async callHierarchyIncomingCalls(
    params: lsp.CallHierarchyIncomingCallsParams,
    _token?: lsp.CancellationToken,
  ): Promise<lsp.CallHierarchyIncomingCall[] | null> {
    console.error('callHierarchyIncomingCalls called!');
    const file = uriToPath(params.item.uri);
    if (!file) {
      return null;
    }
    const uriGenerator = (filePath: string): string => {
      const newPath = pathToUri(filePath, this.documents);
      return newPath;
    };
    return this.cdk.getNodeParents(file, {
      character: params.item.range.start.character,
      line: params.item.range.start.line,
    }, uriGenerator);
  }

  async callHierarchyOutgoingCalls(
    params: lsp.CallHierarchyOutgoingCallsParams,
    _token?: lsp.CancellationToken,
  ): Promise<lsp.CallHierarchyOutgoingCall[] | null> {
    console.error('callHierarchyOutgoingCalls called!');
    const file = uriToPath(params.item.uri);
    if (!file) {
      return null;
    }
    const uriGenerator = (filePath: string): string => {
      const newPath = pathToUri(filePath, this.documents);
      return newPath;
    };
    return this.cdk.getNodeChildren(file, {
      character: params.item.range.start.character,
      line: params.item.range.start.line,
    }, uriGenerator);
  }
}

