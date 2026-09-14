import { BpmnValidationError } from '../errors.js';
import type { BpmnModel, ProcessModel } from './types.js';

/**
 * The process an execution should run: the first one marked `isExecutable`.
 *
 * A collaboration routinely declares black-box pools (`isExecutable="false"`)
 * for external parties, and a tool may emit them before the pool that actually
 * runs — so the first process of the file is not necessarily runnable.
 */
export function findExecutableProcess(model: BpmnModel): ProcessModel | undefined {
  return model.processes.find((process) => process.isExecutable);
}

/**
 * Same as {@link findExecutableProcess}, but states the problem instead of
 * handing back `undefined` for the engine to choke on later.
 *
 * @throws {BpmnValidationError} when no process of the file is executable.
 */
export function executableProcess(model: BpmnModel): ProcessModel {
  const process = findExecutableProcess(model);
  if (process) return process;
  const pools = model.processes.map((p) => p.name ?? p.id).join(', ');
  throw new BpmnValidationError(
    pools
      ? `No executable process in the diagram; every pool is a black box (${pools}).`
      : 'No process found in the diagram.',
  );
}
