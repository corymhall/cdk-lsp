import debounce from 'p-debounce';
import * as lsp from 'vscode-languageserver/node';
import { CdkInitializeParams/* , SupportedFeatures  */ } from './cdk-protocol.js';
import { Cdk } from './cdk.js';
import { DiagnosticEventQueue } from './diagnostic-queue.js';
import { LspDocuments } from './documents.js';
import { LspClient } from './lsp-client.js';
import { uriToPath } from './protocol-translation.js';

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
  private readonly cdk: Cdk;
  private readonly documents = new LspDocuments();
  private diagnosticQueue?: DiagnosticEventQueue;
  public readonly doRequestDiagnosticsDebounced = debounce(() => this.doRequestDiagnostics(), 200);
  protected diagnosticsTokenSource: lsp.CancellationTokenSource | undefined;
  pendingDebouncedRequest = false;
  constructor(private options: CdkServiceConfiguration) {
    this.cdk = new Cdk();

  }
  async initialize(params: CdkInitializeParams): Promise<lsp.InitializeResult> {

    this.diagnosticQueue = new DiagnosticEventQueue(
      diagnostics => this.options.lspClient.publishDiagnostics(diagnostics),
      this.documents,
    );

    this.initializeParams = params;
    const clientCapabilities = this.initializeParams.capabilities;
    const initializeResult: lsp.InitializeResult = {
      capabilities: {
        textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
        // completionProvider: {
        //   triggerCharacters: ['.', '"', '\'', '/', '@', '<'],
        //   resolveProvider: true,
        // },
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
        foldingRangeProvider: true,
        workspace: { },
      },
    };
    return initializeResult;
  }
  public initialized(_: lsp.InitializedParams): void {
    // const { apiVersion, typescriptVersionSource } = this.tspClient;
    // this.options.lspClient.sendNotification(TypescriptVersionNotification, {
    //   version: apiVersion.displayName,
    //   source: typescriptVersionSource,
    // });
  }

  // public codeAction(params: lsp.CodeActionParams, token?: lsp.CancellationToken): Promise<lsp.CodeAction[]> {
  //   const file = uriToPath(params.textDocument.uri);
  //   // lsp.CodeAction.create('action').command = lsp.Command.create()
  // }
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
    // if (this.hasShutDown) {
    //     return;
    // }
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
    }
  }
}

