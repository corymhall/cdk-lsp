import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript/typescript';
import * as lsp from 'vscode-languageserver/node';
import { getCompletion } from './openapi';

const CONSTRUCT_QUERY = `
(expression_statement
  (new_expression
    constructor: [
      (identifier) @construct_name
      (member_expression
        property: (property_identifier) @construct_name
      )
    ]
    arguments: (
      arguments
        (string (string_fragment) @construct_id)?
        (object)? @object_arg
    )
  )
) @construct_code
`;

export class ConstructNapper {
  private readonly treeSitter: Parser;
  constructor() {
    this.treeSitter = new Parser();
    this.treeSitter.setLanguage(TypeScript);
  }

  public captureConstructFromText(text: string): Parser.QueryCapture | undefined {
    const tree = this.treeSitter.parse(text, undefined, { });
    const query = new Parser.Query(TypeScript, CONSTRUCT_QUERY);
    const matches: Parser.QueryMatch[] = query.matches(tree.rootNode);
    for (const match of matches) {
      const captures: Parser.QueryCapture[] = match.captures;
      for (const capture of captures) {
        if (capture.name === 'construct_code' && capture.node.startPosition.row === 0) {
          return capture;
        }
        return;
      };
    };
    return;
  }

  public async getCodeFixForConstruct(
    text: string,
    range: lsp.Range,
    file: string,
    diagnostic: lsp.Diagnostic,
  ): Promise<lsp.CodeAction | undefined> {
    const diagnosticParts = diagnostic.message.split('\n\t');
    const diagnosticName = diagnosticParts[0];
    const diagnosticDescription = diagnosticParts[1];
    const diagnosticFix = diagnosticParts[2];
    const capture = this.captureConstructFromText(text);
    if (capture) {
      const completion = await getCompletion({
        constructCode: capture.node.text,
        fix: diagnosticFix,
        problem: diagnosticDescription,
      });
      if (completion) {
        const action: lsp.CodeAction = {
          title: `FIX: ${diagnosticName.trim()}`,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [file]: [{
                newText: completion,
                range: calculateNewRange(range.start, capture.node.startPosition, capture.node.endPosition),
              }],
            },
          },
        };
        return action;
      } else {
        console.error('NO_COMPLETION');
      }
    }
    return;
  }
}

function calculateNewRange(oldStart: lsp.Position, newStart: Parser.Point, newEnd: Parser.Point): lsp.Range {
  const range: lsp.Range = {
    start: oldStart,
    end: { character: newEnd.column, line: oldStart.line + (newEnd.row - newStart.row) },
  };
  return range;
}
