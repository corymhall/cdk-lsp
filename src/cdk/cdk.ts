import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactType, AwsCloudFormationStackProperties, Manifest, MetadataEntry, NestedCloudAssemblyProperties } from 'aws-cdk-lib/cloud-assembly-schema';
import { Node } from 'aws-cdk-lib/core/lib/private/tree-metadata';
import { ConstructTrace } from 'aws-cdk-lib/core/lib/validation/private/construct-tree';
import { PolicyValidationReportJson } from 'aws-cdk-lib/core/lib/validation/private/report';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import * as lsp from 'vscode-languageserver/node';
import { TraceTree, Tree, TreeNode } from './tree';
import { Mutable } from './utils';
interface Violation {
  ruleName: string;
  locations: string[];
  fix?: string;
  description?: string;
}

export interface TemplateInfo {
  name: string;
  uri: string;
  range: lsp.Range;
}
export class Cdk {
  private readonly templateResourceLineNumbers = new Map<string, TemplateInfo>();
  private tree?: Tree;
  private traceTree?: TraceTree;
  private readonly templateMap = new Map<string, string>();
  private _report: PolicyValidationReportJson | undefined = undefined;
  private readonly out: string;
  private readonly dir: string;
  constructor(root: string) {
    this.dir = this.cdkDir(root);
    const tmpDir = fs.realpathSync(os.tmpdir());
    this.out = path.join(tmpDir, 'cdk.out');
  }

  public clear(): void {
    this._report = undefined;
  }

  public async report(): Promise<PolicyValidationReportJson | undefined> {
    if (this._report) {
      return this._report;
    }
    await this.getReport();
    if (!this._report) await this.synth();
    return this._report;
  }

  private async getViolations(): Promise<Violation[]> {
    function getChildLocation(child: ConstructTrace): string[] {
      const locations: string[] = [];
      if (child.location) locations.push(child.location);
      if (child.child) {
        const childLocations = getChildLocation(child.child);
        locations.push(...childLocations);
      }
      return locations;
    }
    const report = await this.report();
    if (!report) return [];
    const violations: Violation[] = (report.pluginReports).flatMap(r=> {
      return r.violations.flatMap(violation => {
        return {
          fix: violation.fix,
          description: violation.description,
          ruleName: violation.ruleName,
          locations: violation.violatingConstructs.flatMap(construct => {
            const locations = [];
            if (construct.constructStack?.location) locations.push(construct.constructStack.location);
            if (construct.constructStack?.child) {
              locations.push(...getChildLocation(construct.constructStack.child));
            }
            return locations;
          }),
        };
      });
    });
    return violations;
  }

  private async getReport(): Promise<void> {
    const reportPath = path.join(this.out, 'policy-validation-report.json');
    if (fs.existsSync(reportPath)) {
      const report = fs.readFileSync(reportPath).toString('utf-8').trim();
      const parsedReport = JSON.parse(report);
      this._report = parsedReport;
    }
  }

  public async violations(uri: string): Promise<Diagnostic[]> {
    const violations = await this.getViolations();
    return violations.flatMap(violation => {
      return violation.locations.flatMap(location => {
        const regexp = new RegExp(`${uri}:([0-9]+):([0-9]+)`);
        const matches = location.match(regexp);
        if (matches) {
          const line = (+matches[1])-1;
          const character = (+matches[2])-1;
          const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
              end: {
                character,
                line,
              },
              start: {
                character,
                line,
              },
            },
            message: `${violation.ruleName} failed!\n\t${violation.description}\n\t${violation.fix}`,
          };
          return diagnostic;
        }
        return [];
      });
    });
  }

  private parseTree(): TreeNode {
    const rawTree = fs.readFileSync(path.join(this.out, 'tree.json'), 'utf-8');
    const tree: Mutable<Node> = JSON.parse(rawTree).tree;

    function populateParents(parent: Node, children: Mutable<{ [key: string]: Node }>): Mutable<{ [key: string]: Node }> {
      return Object.entries(children).reduce((prev, curr) => {
        const id = curr[0];
        const node = curr[1];
        return {
          ...prev,
          [id]: {
            ...node,
            parent,
            children: node.children ? populateParents(node, node.children) : undefined,
          },
        };
      }, {} as Mutable<{ [key: string]: Node }>);
    }

    return {
      ...tree,
      children: populateParents(tree, tree.children ?? {}),
    };
  }

  private parseTemplates() {
    for (const templateFile of this.templateMap.values()) {
      const templateString = fs.readFileSync(templateFile, { encoding: 'utf-8' });
      const templateArr = templateString.split('\n');
      for (let i = 2; i < templateArr.length-1; i++) {
        const maybeTypeIndex = i+1;
        const maybeTypeField = templateArr[maybeTypeIndex];
        const isTypeIndex = maybeTypeField.match(/.*"Type":\s"AWS::.*",/) !== null;
        if (isTypeIndex) {
          const resourceName = templateArr[i].match(/(\s+)"(\w+)".*/);
          let endIndex: number = i;
          for (let t = i+1; t < templateArr.length-1; t++) {
            const isEnd = templateArr[t].match(`\\s{${resourceName![1].length}}},?`);
            if (isEnd) {
              endIndex = t;
              break;
            }
          }
          this.templateResourceLineNumbers.set(resourceName![2], {
            name: resourceName![2],
            uri: templateFile,
            range: {
              start: {
                character: 0,
                line: i,
              },
              end: {
                character: 0,
                line: endIndex,
              },
            },
          });
        }
      }
    }
  }

  private parseManifest(): TraceTree {
    let combinedMetadata: { [key: string]: MetadataEntry[] } = {};
    const templateMap = this.templateMap;
    function process(dir: string): void {
      const manifest = Manifest.loadAssemblyManifest(path.join(dir, 'manifest.json'));
      for (const [key, value] of Object.entries(manifest.artifacts ?? {})) {
        if (value.type === ArtifactType.AWS_CLOUDFORMATION_STACK) {
          const props = value.properties as AwsCloudFormationStackProperties;
          const templateFile = props.templateFile;
          templateMap.set(key, path.join(dir, templateFile));
          if (value.metadata) {
            combinedMetadata = {
              ...combinedMetadata,
              ...value.metadata,
            };
          }
        } else if (value.type === ArtifactType.NESTED_CLOUD_ASSEMBLY) {
          const props = value.properties as NestedCloudAssemblyProperties;
          if (props.directoryName) {
            process(path.join(dir, props.directoryName));
          }
        }
      }
    }
    process(this.out);
    return new TraceTree(combinedMetadata);
  }

  public getNodeResources(file: string, startPosition: lsp.Position, uriGenerator: (file: string) => string): lsp.LocationLink[] {
    const node = this.tree?.getNode(`${file}:${startPosition.line}`);
    if (!node) {
      return [];
    }
    const calls: lsp.LocationLink[] = [];
    const children: typeof node.children = {
      [node.id]: node,
      ...node.children,
    };
    const tree = this.tree!;
    const templateResourceLineNumbers = this.templateResourceLineNumbers;
    const resourceToTypeHierarchyItem = this.resourceToLocationLink;
    function getChildResources(childs: { [key: string]: TreeNode }) {
      Object.values(childs).forEach(child => {
        const logicalId = tree.getNodeLogicalId(child);
        if (logicalId) {
          templateResourceLineNumbers.get(logicalId);
          for (const value of templateResourceLineNumbers.values()) {
            calls.push(resourceToTypeHierarchyItem(value, uriGenerator));
          }
          if (child.children) {
            getChildResources(child.children);
          }
        }
      });
    }
    getChildResources(children);
    return calls;


  }

  public getNodeParents(file: string, startPosition: lsp.Position, uriGenerator: (file: string) => string): lsp.CallHierarchyIncomingCall[] {
    const node = this.tree?.getNodeBranch(`${file}:${startPosition.line}`);
    if (!node) {
      return [];
    }

    const nodeToCallHierarchyItem = this.nodeToCallHierarchyItem;
    const calls: lsp.CallHierarchyIncomingCall[] = [];
    function children(child: { [key: string]: TreeNode }): void {
      Object.values(child).forEach((n) => {
        if (!n.children) return;
        if (n.uri) {
          calls.push({
            from: nodeToCallHierarchyItem(n, uriGenerator),
            fromRanges: [{
              end: n.startPosition!,
              start: n.startPosition!,
            }],
          });
        }
        children(n.children);
      });
    }
    children({ [node.id]: node });
    console.error(calls);
    return calls;
  }

  public getNodeChildren(file: string, startPosition: lsp.Position, uriGenerator: (file: string) => string): lsp.CallHierarchyOutgoingCall[] {
    const node = this.tree?.getNode(`${file}:${startPosition.line}`);
    if (!node) {
      return [];
    }

    const nodeToCallHierarchyItem = this.nodeToCallHierarchyItem;
    const calls: lsp.CallHierarchyOutgoingCall[] = [];
    const seen = new Set<string>();
    function children(child: { [key: string]: TreeNode }): void {
      Object.values(child).forEach((n) => {
        if (!n.children) return;
        if (n.uri) {
          const key = `${n.path}:${n.startPosition?.line}`;
          if (seen.has(key)) return;
          calls.push({
            to: nodeToCallHierarchyItem(n, uriGenerator),
            fromRanges: [{
              end: n.startPosition!,
              start: n.startPosition!,
            }],
          });
          seen.add(key);
        }
        children(n.children);
      });
    }
    children({ [node.id]: node });
    console.error(calls);
    return Array.from(calls);
  }

  private resourceToLocationLink(resource: TemplateInfo, uriGenerator: (file: string) => string): lsp.LocationLink {
    console.error('RESOURCE_RANGE', resource.range);
    return {
      targetRange: resource.range,
      targetSelectionRange: resource.range,
      targetUri: uriGenerator(resource.uri!),
    };
  }

  private nodeToCallHierarchyItem(node: TreeNode, uriGenerator: (file: string) => string): lsp.CallHierarchyItem {
    return {
      kind: lsp.SymbolKind.Class,
      name: `${node.id} (${node.path})`,
      range: {
        end: node.startPosition!,
        start: node.startPosition!,
      },
      selectionRange: {
        end: node.startPosition!,
        start: node.startPosition!,
      },
      uri: uriGenerator(node.uri!),
    };
  }

  public getNodeTree(file: string, startPosition: lsp.Position, uriGenerator: (file: string) => string): lsp.CallHierarchyItem[] {
    const node = this.tree?.getNodeBranch(`${file}:${startPosition.line}`);
    if (!node) {
      return [];
    }
    const items: lsp.CallHierarchyItem[] = [];
    if (node.uri) {
      items.push(this.nodeToCallHierarchyItem(node, uriGenerator));
    }
    items.push(...Object.entries(node.children ?? {}).flatMap(([_id, value]) => {
      return this.nodeToCallHierarchyItem(value, uriGenerator);
    }));
    return items;

  }

  public async synth(): Promise<void> {
    try {
      execSync([
        'npx', 'cdk', 'synth',
        '--context', '@aws-cdk/core:validationReportJson=true',
        '--debug',
        '--output', this.out,
        '--quiet',
        '--no-lookups',
      ].join(' '), {
        cwd: this.dir,
      });
    } finally {
      const tree = this.parseTree();
      this.traceTree = this.parseManifest();
      this.parseTemplates();
      this.tree = new Tree(tree, this.traceTree);
      await this.getReport();
    }
  }

  private cdkDir(dir: string): string {
    console.log('DIR!!!!!!!!!!!!!', dir);
    const exists = fs.existsSync(path.join(dir, 'cdk.json'));
    if (exists) return dir;
    return this.cdkDir(path.dirname(dir));
  }
}
