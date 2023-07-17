import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConstructTrace } from 'aws-cdk-lib/core/lib/validation/private/construct-tree';
import { PolicyValidationReportJson } from 'aws-cdk-lib/core/lib/validation/private/report';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
interface Violation {
  ruleName: string;
  locations: string[];
  fix?: string;
  description?: string;
}

export class Cdk {
  private _report: PolicyValidationReportJson | undefined = undefined;
  private readonly out: string;
  private readonly dir: string;
  constructor() {
    this.dir = this.cdkDir(process.cwd());
    const tmpDir = fs.realpathSync(os.tmpdir());
    this.out = path.join(tmpDir, 'cdk.out');
  }

  public clear(): void {
    this._report = undefined;
  }

  public async report(): Promise<PolicyValidationReportJson> {
    if (this._report) {
      return this._report;
    }
    await this.synth();
    await this.getReport();
    return this._report!;
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
    const report = fs.readFileSync(path.join(this.out, 'policy-validation-report.json')).toString('utf-8').trim();
    const parsedReport = JSON.parse(report);
    this._report = parsedReport;
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

  public async synth(): Promise<void> {
    try {
      execSync([
        'npx', 'cdk', 'synth',
        '--context', '@aws-cdk/core:validationReportJson=true',
        '--debug',
        '--output', this.out,
        '--quiet',
      ].join(' '), {
        cwd: this.dir,
      });
    } catch { /* empty */ }
  }

  private cdkDir(dir: string): string {
    console.log('DIR!!!!!!!!!!!!!', dir);
    const files = fs.readdirSync(dir);
    if (files.includes('cdk.json')) {
      return dir;
    } else {
      return this.cdkDir(path.dirname(dir));
    }
  }
}
