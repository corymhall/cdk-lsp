/**
 * **IMPORTANT** this module should not depend on `vscode-languageserver` only protocol and types
 */
import * as lsp from 'vscode-languageserver-protocol';

export interface SupportedFeatures {
  codeActionDisabledSupport?: boolean;
  completionCommitCharactersSupport?: boolean;
  completionInsertReplaceSupport?: boolean;
  completionLabelDetails?: boolean;
  completionSnippets?: boolean;
  completionDisableFilterText?: boolean;
  definitionLinkSupport?: boolean;
  diagnosticsTagSupport?: boolean;
}
export interface CdkInitializationOptions {
}
export type CdkInitializeParams = lsp.InitializeParams & {
  initializationOptions?: Partial<CdkInitializationOptions>;
};
