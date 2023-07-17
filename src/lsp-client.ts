import { MessageType } from 'vscode-languageserver';
import { attachWorkDone } from 'vscode-languageserver/lib/common/progress';
import * as lsp from 'vscode-languageserver/node';
export interface WithProgressOptions {
  message: string;
  reporter: lsp.WorkDoneProgressReporter;
}
export interface LspClient {
  createProgressReporter(token?: lsp.CancellationToken, workDoneProgress?: lsp.WorkDoneProgressReporter): Promise<lsp.WorkDoneProgressReporter>;
  withProgress<R>(options: WithProgressOptions, task: (progress: lsp.WorkDoneProgressReporter) => Promise<R>): Promise<R>;
  publishDiagnostics(args: lsp.PublishDiagnosticsParams): void;
  showErrorMessage(message: string): void;
  logMessage(args: lsp.LogMessageParams): void;
  applyWorkspaceEdit(args: lsp.ApplyWorkspaceEditParams): Promise<lsp.ApplyWorkspaceEditResult>;
  sendNotification<P>(type: lsp.NotificationType<P>, params: P): Promise<void>;
}

// Hack around the LSP library that makes it otherwise impossible to differentiate between Null and Client-initiated reporter.
const nullProgressReporter = attachWorkDone(undefined as any, /* params */ undefined);

export class LspClientImpl implements LspClient {
  constructor(protected connection: lsp.Connection) {}

  async createProgressReporter(_?: lsp.CancellationToken, workDoneProgress?: lsp.WorkDoneProgressReporter): Promise<lsp.WorkDoneProgressReporter> {
    let reporter: lsp.WorkDoneProgressReporter;
    if (workDoneProgress && workDoneProgress.constructor !== nullProgressReporter.constructor) {
      reporter = workDoneProgress;
    } else {
      reporter = workDoneProgress || await this.connection.window.createWorkDoneProgress();
    }
    return reporter;
  }

  async withProgress<R = unknown>(options: WithProgressOptions, task: (progress: lsp.WorkDoneProgressReporter) => Promise<R>): Promise<R> {
    const { message, reporter } = options;
    reporter.begin(message);
    return task(reporter).then(result => {
      reporter.done();
      return result;
    });
  }

  async publishDiagnostics(params: lsp.PublishDiagnosticsParams): Promise<void> {
    await this.connection.sendDiagnostics(params);
  }

  async showErrorMessage(message: string): Promise<void> {
    await this.connection.sendNotification(lsp.ShowMessageNotification.type, { type: MessageType.Error, message });
  }

  async logMessage(args: lsp.LogMessageParams): Promise<void> {
    await this.connection.sendNotification(lsp.LogMessageNotification.type, args);
  }

  async applyWorkspaceEdit(params: lsp.ApplyWorkspaceEditParams): Promise<lsp.ApplyWorkspaceEditResult> {
    return this.connection.workspace.applyEdit(params);
  }

  async sendNotification<P>(type: lsp.NotificationType<P>, params: P): Promise<void> {
    await this.connection.sendNotification(type, params);
  }
}
