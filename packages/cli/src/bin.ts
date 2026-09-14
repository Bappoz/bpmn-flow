#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect, isCollaboration, run, runCollaboration, validate } from './commands.js';
import { parseBpmn } from '@bpmn-flow/core';
import type { CollaborationState, EngineMode, EngineState, TaskHandler } from '@bpmn-flow/core';

const USAGE = `bpmn-flow — BPMN 2.0 from the terminal

  bpmn-flow validate <file.bpmn>
  bpmn-flow inspect  <file.bpmn>
  bpmn-flow run      <file.bpmn> [options]

A file with more than one executable pool runs as a collaboration: every pool
executes and the message flows between them are routed.

Options for run:
  --vars <json>      initial process variables, e.g. '{"valor":2500}'
  --mode <mode>      automation (default, pauses on user tasks) | auto
  --handlers <file>  ES module default-exporting { nodeId: handler } automation
  --incidents        hold a failing activity instead of failing the run
  --retry <n>        retry a failing handler n times before giving up
  --state <file>     continue a run stored with --save
  --save <file>      write the execution state when it pauses
  --js-expressions   evaluate expressions as full JavaScript instead of through
                     the safe evaluator (only for diagrams you trust)
`;

/** Reads `--name value` or `--name=value`. */
function arg(argv: string[], name: string): string | undefined {
  const index = argv.findIndex((item) => item === `--${name}` || item.startsWith(`--${name}=`));
  if (index === -1) return undefined;
  const current = argv[index]!;
  return current.includes('=') ? current.split('=').slice(1).join('=') : argv[index + 1];
}

/** Imports an ES module whose default export maps selectors to handlers. */
async function loadHandlers(file: string): Promise<Record<string, TaskHandler>> {
  const imported = (await import(pathToFileURL(resolve(file)).href)) as {
    default?: Record<string, TaskHandler>;
  };
  if (!imported.default) throw new Error(`${file} must default-export the handlers.`);
  return imported.default;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const [command, file] = argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (!file || file.startsWith('--')) {
    console.error(`Missing file for "${command}".\n\n${USAGE}`);
    return 2;
  }

  const xml = await readFile(file, 'utf8');

  switch (command) {
    case 'validate': {
      const result = await validate(xml);
      console.log(result.output);
      return result.exitCode;
    }
    case 'inspect': {
      const result = await inspect(xml);
      console.log(result.output);
      return result.exitCode;
    }
    case 'run': {
      const varsText = arg(argv, 'vars');
      const stateFile = arg(argv, 'state');
      const saveFile = arg(argv, 'save');
      const mode = arg(argv, 'mode') as EngineMode | undefined;

      const handlersFile = arg(argv, 'handlers');
      const retries = arg(argv, 'retry');
      const handlers = handlersFile ? await loadHandlers(handlersFile) : undefined;

      const shared = {
        ...(varsText ? { variables: JSON.parse(varsText) as Record<string, unknown> } : {}),
        ...(mode ? { mode } : {}),
        ...(handlers ? { handlers } : {}),
        ...(argv.includes('--incidents') ? { onHandlerError: 'incident' as const } : {}),
        ...(retries ? { retry: { attempts: Number(retries) } } : {}),
        ...(argv.includes('--js-expressions') ? { expressions: 'javascript' as const } : {}),
      };
      const stored = stateFile ? await readFile(stateFile, 'utf8') : undefined;

      // More than one executable pool: run the whole collaboration, with the
      // message flows routed between the pools.
      const result = isCollaboration(await parseBpmn(xml))
        ? await runCollaboration(xml, {
            ...shared,
            ...(stored ? { state: JSON.parse(stored) as CollaborationState } : {}),
          })
        : await run(xml, {
            ...shared,
            ...(stored ? { state: JSON.parse(stored) as EngineState } : {}),
          });
      console.log(result.output);
      if (saveFile) {
        await writeFile(saveFile, JSON.stringify(result.state, null, 2), 'utf8');
        console.log(`state saved to ${saveFile}`);
      }
      return result.exitCode;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
