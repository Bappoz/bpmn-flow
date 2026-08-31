/** Base class for all errors raised by @bpmn-flow/core. */
export class BpmnFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Raised when the BPMN XML cannot be parsed into a valid model. */
export class BpmnParseError extends BpmnFlowError {}

/** Raised when a process definition is structurally invalid for execution. */
export class BpmnValidationError extends BpmnFlowError {}

/** Raised when the engine reaches an unsupported or inconsistent state. */
export class BpmnExecutionError extends BpmnFlowError {}

/**
 * Raised when an expression cannot be parsed or reaches something the safe
 * evaluator does not allow. Callers treat it as `undefined` (a condition then
 * reads as `false`), so it rarely escapes the engine.
 */
export class BpmnExpressionError extends BpmnFlowError {}
