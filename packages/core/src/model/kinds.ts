/**
 * BPMN 2.0 element taxonomy used throughout the normalized model.
 *
 * The parser maps every recognized BPMN element onto one of these kinds, so
 * downstream consumers (engine, viewer) never touch raw XML type names.
 */

export const EVENT_KINDS = [
  'startEvent',
  'endEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
  'boundaryEvent',
] as const;

export const TASK_KINDS = [
  'task',
  'userTask',
  'serviceTask',
  'scriptTask',
  'businessRuleTask',
  'sendTask',
  'receiveTask',
  'manualTask',
] as const;

export const SUBPROCESS_KINDS = [
  'subProcess',
  'transaction',
  'adHocSubProcess',
  'callActivity',
] as const;

export const GATEWAY_KINDS = [
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
  'complexGateway',
] as const;

/**
 * Data declarations. These are not flow nodes: no token ever sits on one, so
 * they stay out of {@link ElementKind} and live in `ProcessModel.dataElements`.
 * They describe what data the process declares, which is what `ioSpecification`
 * and a data-flow view need.
 */
export const DATA_ELEMENT_KINDS = [
  'dataObject',
  'dataObjectReference',
  'dataStore',
  'dataStoreReference',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
export type TaskKind = (typeof TASK_KINDS)[number];
export type SubProcessKind = (typeof SUBPROCESS_KINDS)[number];
export type GatewayKind = (typeof GATEWAY_KINDS)[number];
export type DataElementKind = (typeof DATA_ELEMENT_KINDS)[number];

/** Every executable flow node kind the model can represent. */
export type ElementKind = EventKind | TaskKind | SubProcessKind | GatewayKind;

/** Trigger attached to an event (or event-based construct). */
export type EventDefinitionKind =
  | 'none'
  | 'message'
  | 'timer'
  | 'error'
  | 'signal'
  | 'conditional'
  | 'escalation'
  | 'compensation'
  | 'cancel'
  | 'terminate'
  | 'link';

const EVENT_SET: ReadonlySet<string> = new Set(EVENT_KINDS);
const TASK_SET: ReadonlySet<string> = new Set(TASK_KINDS);
const SUBPROCESS_SET: ReadonlySet<string> = new Set(SUBPROCESS_KINDS);
const GATEWAY_SET: ReadonlySet<string> = new Set(GATEWAY_KINDS);
const DATA_SET: ReadonlySet<string> = new Set(DATA_ELEMENT_KINDS);

export const isEventKind = (kind: ElementKind): kind is EventKind => EVENT_SET.has(kind);
export const isTaskKind = (kind: ElementKind): kind is TaskKind => TASK_SET.has(kind);
export const isSubProcessKind = (kind: ElementKind): kind is SubProcessKind =>
  SUBPROCESS_SET.has(kind);
export const isGatewayKind = (kind: ElementKind): kind is GatewayKind => GATEWAY_SET.has(kind);

export const isDataElementKind = (kind: string): kind is DataElementKind => DATA_SET.has(kind);

/** Activities are tasks plus subprocess-like containers. */
export const isActivityKind = (kind: ElementKind): boolean =>
  isTaskKind(kind) || isSubProcessKind(kind);
