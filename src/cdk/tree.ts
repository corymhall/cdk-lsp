import { MetadataEntry } from 'aws-cdk-lib/cloud-assembly-schema';
import { Node } from 'aws-cdk-lib/core/lib/private/tree-metadata';
import { ConstructTrace } from 'aws-cdk-lib/core/lib/validation/private/construct-tree';
import * as lsp from 'vscode-languageserver/node';
import { Mutable } from './utils';

export interface TreeNode extends Node {
  readonly uri?: string;
  readonly startPosition?: lsp.Position;
  readonly children?: { [key: string]: TreeNode };
  readonly parent?: TreeNode;
}
export class Tree {
  private readonly _tree: { [key: string]: TreeNode };
  private readonly locationMap = new Map<string, string>();
  constructor(tree: Node, private readonly traceTree: TraceTree) {
    this._tree = this.nodeToTreeNode(
      { [tree.id]: tree },
      traceTree,
    );
  }

  private nodeToTreeNode(tree: { [key: string]: TreeNode }, traceTree: TraceTree, parent?: TreeNode): { [key: string]: TreeNode } {
    const parseLocation = this.parseLocation;
    let newTree: { [key: string]: TreeNode } = {};
    Object.entries(tree).forEach(([id, node]) => {
      const ret: Mutable<TreeNode> = {
        ...node,
        parent: parent,
      };
      if (id !== 'App') {
        const trace = traceTree.getTrace(node);
        const location = trace?.location;

        if (location) {
          const parsed = parseLocation(location);
          if (parsed && !parsed.url.includes('node_modules')) {
            this.locationMap.set(parsed.mapKey, id);
            ret.startPosition = parsed.startPosition;
            ret.uri = parsed.url;
          }
        }
      }
      const children = ret.children ? this.nodeToTreeNode(ret.children, traceTree, ret) : undefined;
      ret.children = children;
      newTree = {
        ...children ? children : {},
        ...newTree,
        [id]: ret,
      };
    });
    return newTree;
  }

  private parseLocation(location: string): { url: string; startPosition: lsp.Position; mapKey: string } | undefined {
    const regexp = new RegExp(/\((.*)\:(\d+)\:(\d+)\)$/);
    const matches = location.match(regexp);
    if (matches) {
      const url = matches[1];
      const line = +matches[2];
      const zLine = line === 0 ? line : line -1;
      const char = +matches[3];
      const zChar = char === 0 ? char : char -1;
      return {
        mapKey: `${url}:${zLine}`,
        url,
        startPosition: {
          line: zLine,
          character: zChar,
        },
      };
    }
    return;

  }

  /**
   * Construct a new tree with only the nodes that we care about.
   * Normally each node can contain many child nodes, but we only care about the
   * tree that leads to a specific construct so drop any nodes not in that path
   *
   * @param node Node the current tree node
   * @param child Node the previous tree node and the current node's child node
   * @returns Node the new tree
   */
  private renderTreeWithChildren(node: TreeNode, child?: TreeNode): TreeNode {
    if (node.parent) {
      return this.renderTreeWithChildren(node.parent, node);
    } else if (child) {
      return {
        ...node,
        children: {
          [child.id]: child,
        },
      };
    }
    return node;
  }

  /**
   * This gets a specific "branch" of the tree for a given construct path.
   * It will return the root Node of the tree with non-relevant branches filtered
   * out (i.e. node children that don't traverse to the given construct path)
   */
  public getNodeBranch(traceUri: string): TreeNode | undefined {
    const id = this.locationMap.get(traceUri);
    if (id) {
      const tree = this._tree[id];
      return this.renderTreeWithChildren(tree);
    }
    return;
  }

  public getNodeLogicalId(node: TreeNode): string | undefined {
    const metadata = this.traceTree.getMetadataEntryByPath(node.path+'/Resource');
    if (metadata?.data) {
      return metadata.data as string;
    }
    return;
  }

  public getNode(traceUri: string): TreeNode | undefined {
    const id = this.locationMap.get(traceUri);
    if (id) {
      return this._tree[id];
    }
    return;
  }
}

export class TraceTree {
  private readonly _resourceMetadataByPath: Map<string, MetadataEntry> = new Map();
  private readonly _traceCache = new Map<string, ConstructTrace>();
  constructor(stackMetadata: { [key: string]: MetadataEntry[] }) {
    Object.entries(stackMetadata).forEach(([id, entry]) => {
      if (entry[0].type === 'aws:cdk:logicalId') {
        this._resourceMetadataByPath.set(id, entry[0]);
      }
    });
  }

  /**
   * @param path the node.addr of the construct
   * @returns the Construct
   */
  public getMetadataEntryByPath(path: string): MetadataEntry | undefined {
    return this._resourceMetadataByPath.get(`/${path}`);
  }

  /**
   * Get the stack trace from the construct node metadata.
   * The stack trace only gets recorded if the node is a `CfnResource`,
   * but the stack trace will have entries for all types of parent construct
   * scopes
   */
  private getTraceMetadata(size: number, node?: Node): string[] {
    if (node) {
      const metadata = this.getMetadataEntryByPath(node.path);
      if (metadata) {
        const trace = (metadata.trace ?? []).flatMap((t, i) => {
          if (i !== 0 && t.includes('node_modules')) {
            return [];
          }
          if (!t.match(/\(\/.*:\d+:\d+.*\)/)) {
            return [];
          }
          return t;
        });
        // take just the items we need and reverse it since we are
        // displaying the trace bottom up
        return Object.create(trace.slice(0, size));
      }
    }
    return [];
  }

  /**
   * Only the `CfnResource` constructs contain the trace information
   * So we need to go down the tree and find that resource (its always the last one)
   *
   * @param node Node the entire tree where the bottom is the violating resource
   * @return Node the bottom of the tree which will be the violating resource
   */
  private getNodeWithTrace(node: Node): Node {
    if (node.children) {
      return this.getNodeWithTrace(this.getChild(node.children));
    }
    return node;
  }

  /**
   * Get a ConstructTrace from the cache for a given construct
   *
   * Construct the stack trace of constructs. This will start with the
   * root of the tree and go down to the construct that has the violation
   */
  public getTrace(node: Node, locations?: string[]): ConstructTrace | undefined {
    const trace = this._traceCache.get(node.path);
    if (trace) {
      return trace;
    }

    const size = this.nodeSize(node);

    const nodeWithTrace = this.getNodeWithTrace(node);
    const metadata = (locations ?? this.getTraceMetadata(size, nodeWithTrace));
    const thisLocation = metadata.pop();

    const constructTrace: ConstructTrace = {
      id: node.id,
      path: node.path,
      // the "child" trace will be the "parent" node
      // since we are going bottom up
      child: node.children
        ? this.getTrace(this.getChild(node.children), metadata)
        : undefined,
      construct: node.constructInfo?.fqn,
      libraryVersion: node.constructInfo?.version,
      location: thisLocation ?? "Run with '--debug' to include location info",
    };
    this._traceCache.set(constructTrace.path, constructTrace);
    return constructTrace;
  }

  /**
   * Each node will only have a single child so just
   * return that
   */
  private getChild(children: { [key: string]: Node }): Node {
    return Object.values(children)[0];
  }

  /**
   * Get the size of a Node, i.e. how many levels is it
   */
  private nodeSize(node: Node): number {
    let size = 1;
    if (!node.children) {
      return size;
    }
    let children: Node | undefined = this.getChild(node.children);
    do {
      size++;
      children = children.children
        ? this.getChild(children.children)
        : undefined;
    } while (children);

    return size;
  }
}
