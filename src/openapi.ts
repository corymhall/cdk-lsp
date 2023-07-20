import * as openapi from 'openai';

const api = new openapi.OpenAIApi(new openapi.Configuration({
  apiKey: process.env.OPENAI_API_KEY,
}));

export interface PolicyViolation {
  problem: string;
  fix: string;
  constructCode: string;
}
export async function getCompletion(violation: PolicyViolation): Promise<string | undefined> {
  try {
    const completion = await api.createChatCompletion({
      model: 'gpt-3.5-turbo',
      top_p: 1,
      temperature: 1,
      max_tokens: 256,
      frequency_penalty: 0,
      presence_penalty: 0,
      messages: [
        {
          role: 'system', content: generateSystemContent(violation),
        },
        {
          role: 'user', content: generatePrompt(violation),
        },
      ],
      stream: false,
    });
    return completion.data.choices[0].message?.content;
  } catch (e: any) {
    if (e.response) {
      console.error(e.response.status, e.response.data);
    } else {
      console.error(`Error with OpenAI API request: ${e.message}`);
    }
    throw new Error(e);
  }
}

function generateSystemContent(violation: PolicyViolation) {
  return `
You are a coding helper that receives information on non-compliant
code and provides replacement code. Your response will be used as input
to a program so the code that you provide should be able to replace the code provided.

A certain compliance rule states
${violation.problem}

And the fix is described as
${violation.fix}
`;
}
function generatePrompt(violation: PolicyViolation) {
  return `
Can you update the following TypeScript AWS CDK code to be compliant.
Please only provide the specific code, no import statements and no explanation.

${violation.constructCode}
`;
}

// const testPolicyViolation: PolicyViolation = {
//   constructCode: "new s3.Bucket(this, 'Bucket', {\n      accessControl: s3.BucketAccessControl.PRIVATE,\n      bucketName: 'mybucket',\n    });",
//   fix: "[FIX]: The parameters 'BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets' must be set to true under the bucket-level 'PublicAccessBlockConfiguration'.",
//   problem: '[CT.S3.PR.1]: Require an Amazon S3 bucket to have block public access settings configured',
// };

// async function main() {
//
//   const completion = await getCompletion(testPolicyViolation);
//   console.log(completion);
// }

// main().then(() => {console.log('done'); }).catch((e) => { console.log(e); });
