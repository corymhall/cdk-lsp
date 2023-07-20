import * as fs from 'fs';
import { TemplateInfo } from './cdk';

function main() {
  const path = '/tmp/cdk.out/CdkLspTestAppStack.template.json';
  const templateString = fs.readFileSync(path, { encoding: 'utf-8' });
  const templateArr = templateString.split('\n');
  console.log(templateArr);
  const resources = new Map<string, TemplateInfo>();
  for (let i = 2; i < templateArr.length-1; i++) {
    const maybeTypeIndex = i+1;
    console.log(maybeTypeIndex);
    const maybeTypeField = templateArr[maybeTypeIndex];
    console.log(maybeTypeField);
    const isTypeIndex = maybeTypeField.match(/.*"Type":\s"AWS::.*",/) !== null;
    if (isTypeIndex) {
      const resourceName = templateArr[i].match(/(\s+)"(\w+)".*/);
      console.log(resourceName);
      let endIndex: number = i;
      for (let t = i+1; t < templateArr.length-1; t++) {
        console.log(`\\s{${resourceName![1].length}}".*`);
        const isEnd = templateArr[t].match(`\\s{${resourceName![1].length}}},?`);
        console.log(isEnd);
        if (isEnd) {
          endIndex = t;
          break;
        }
      }

      resources.set(resourceName![2], {
        name: resourceName![2],
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
        uri: '',
      });
    }
  }
  for (const value of resources.values()) {
    console.log(JSON.stringify(value, undefined, 2));
  }
}

main();
