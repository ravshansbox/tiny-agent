import Anthropic from '@anthropic-ai/sdk';
import readline from 'readline';
import { readFile, writeFile, editFile, listDir, searchInFiles, runCommand } from './tools.js';

type ToolInput = {
  filePath?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  dirPath?: string;
  pattern?: string;
  command?: string;
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number };
};

type ToolLogEntry = {
  name: string;
  input: ToolInput;
  output: string;
};

const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
const baseURL = process.env.ANTHROPIC_BASE_URL;

if (!apiKey) {
  process.stderr.write('Missing ANTHROPIC_AUTH_TOKEN\n');
  process.exit(1);
}

const client = new Anthropic({ apiKey, baseURL });

const tools = [
  {
    name: 'readFile',
    description: 'Read a text file and return its contents.',
    input_schema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  },
  {
    name: 'writeFile',
    description: 'Write a text file, creating parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: { filePath: { type: 'string' }, content: { type: 'string' } },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'editFile',
    description: 'Replace the first exact match of oldText with newText.',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
      required: ['filePath', 'oldText', 'newText'],
    },
  },
  {
    name: 'listDir',
    description: 'List directory entries with / suffix for directories.',
    input_schema: { type: 'object', properties: { dirPath: { type: 'string' } }, required: [] },
  },
  {
    name: 'searchInFiles',
    description: 'Search files for a pattern and return matches.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, dirPath: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'runCommand',
    description: 'Run a shell command and return stdout/stderr.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, options: { type: 'object' } },
      required: ['command'],
    },
  },
] satisfies Anthropic.Messages.Tool[];

const toolList = `Available tools:\n- readFile({ filePath })\n- writeFile({ filePath, content })\n- editFile({ filePath, oldText, newText })\n- listDir({ dirPath })\n- searchInFiles({ pattern, dirPath })\n- runCommand({ command, options })`;

const systemPrompt = `You are a coding agent. Use tools when needed. ${toolList}`;

const requireString = (value: unknown, name: string) => {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${name}`);
  }
  return value;
};

const normalizeToolInput = (input: unknown): ToolInput => {
  if (input && typeof input === 'object') {
    return input as ToolInput;
  }
  return {};
};

const formatError = (err: unknown) => (err instanceof Error ? err.message : String(err));

const runTool = async (name: string, input: ToolInput) => {
  if (name === 'readFile') {
    return readFile(requireString(input.filePath, 'filePath'));
  }
  if (name === 'writeFile') {
    await writeFile(requireString(input.filePath, 'filePath'), requireString(input.content, 'content'));
    return 'ok';
  }
  if (name === 'editFile') {
    await editFile(
      requireString(input.filePath, 'filePath'),
      requireString(input.oldText, 'oldText'),
      requireString(input.newText, 'newText')
    );
    return 'ok';
  }
  if (name === 'listDir') {
    return typeof input.dirPath === 'string' ? listDir(input.dirPath) : listDir();
  }
  if (name === 'searchInFiles') {
    const pattern = requireString(input.pattern, 'pattern');
    return typeof input.dirPath === 'string' ? searchInFiles(pattern, input.dirPath) : searchInFiles(pattern);
  }
  if (name === 'runCommand') {
    const command = requireString(input.command, 'command');
    const options = typeof input.options === 'object' && input.options !== null ? input.options : undefined;
    return runCommand(command, options);
  }
  throw new Error(`Unknown tool: ${name}`);
};

const runWithTools = async (prompt: string, onToolLog: (entry: ToolLogEntry) => void) => {
  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: prompt }];
  for (let i = 0; i < 6; i += 1) {
    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: 512,
      system: systemPrompt,
      tools,
      messages,
    });
    const toolUses = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use'
    );
    if (toolUses.length === 0) {
      const text = response.content
        .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return text;
    }
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const toolInput = normalizeToolInput(toolUse.input);
      const result = await runTool(toolUse.name, toolInput);
      const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      onToolLog({ name: toolUse.name, input: toolInput, output: content });
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content });
    }
    messages.push({ role: 'assistant', content: response.content as Anthropic.Messages.ContentBlockParam[] });
    messages.push({ role: 'user', content: toolResults });
  }
  return 'Tool loop limit reached';
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));

const printSeparator = () => {
  const columns = process.stdout.columns || 80;
  process.stdout.write('─'.repeat(Math.max(columns, 1)) + '\n');
};

const main = async () => {
  while (true) {
    printSeparator();
    const input = await ask('');
    if (!input.trim()) {
      continue;
    }
    process.stdout.write('\n');
    const toolLogs: ToolLogEntry[] = [];
    const onToolLog = (entry: ToolLogEntry) => {
      toolLogs.push(entry);
      process.stdout.write(`tool ${entry.name}\n`);
      process.stdout.write(JSON.stringify(entry.input) + '\n');
      process.stdout.write(entry.output + '\n');
    };
    try {
      const answer = await runWithTools(input, onToolLog);
      process.stdout.write('\n' + answer + '\n');
    } catch (err) {
      process.stderr.write(formatError(err) + '\n');
    }
  }
};

process.on('SIGINT', () => {
  rl.close();
  process.stdout.write('\n');
  process.exit(0);
});

main().catch((error) => {
  process.stderr.write(formatError(error) + '\n');
  process.exit(1);
});
