/**
 * Hand-written BPMN 2.0 fixtures, one per execution pattern under test.
 * Diagram interchange is intentionally omitted; the engine only needs semantics.
 */

const NS =
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'targetNamespace="http://bpmn-flow.test"';

function wrap(inner: string, processId = 'P'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:process id="${processId}" isExecutable="true">
${inner}
  </bpmn:process>
</bpmn:definitions>`;
}

function cond(body: string): string {
  return `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${body}</bpmn:conditionExpression>`;
}

export const LINEAR = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge" name="Charge card" />
    <bpmn:userTask id="Approve" name="Manual approval" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f2" sourceRef="Charge" targetRef="Approve" />
    <bpmn:sequenceFlow id="f3" sourceRef="Approve" targetRef="End" />`);

export const EXCLUSIVE = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:exclusiveGateway id="Gw" default="fLow" />
    <bpmn:task id="High" />
    <bpmn:task id="Low" />
    <bpmn:endEvent id="EndHigh" />
    <bpmn:endEvent id="EndLow" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Gw" />
    <bpmn:sequenceFlow id="fHigh" sourceRef="Gw" targetRef="High">${cond('amount &gt; 100')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fLow" sourceRef="Gw" targetRef="Low" />
    <bpmn:sequenceFlow id="fh2" sourceRef="High" targetRef="EndHigh" />
    <bpmn:sequenceFlow id="fl2" sourceRef="Low" targetRef="EndLow" />`);

export const PARALLEL = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:task id="A" />
    <bpmn:task id="B" />
    <bpmn:parallelGateway id="Join" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="A" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="B" />
    <bpmn:sequenceFlow id="fa2" sourceRef="A" targetRef="Join" />
    <bpmn:sequenceFlow id="fb2" sourceRef="B" targetRef="Join" />
    <bpmn:sequenceFlow id="fj" sourceRef="Join" targetRef="End" />`);

export const INCLUSIVE = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:inclusiveGateway id="Split" default="fDef" />
    <bpmn:task id="X" />
    <bpmn:task id="Y" />
    <bpmn:task id="Z" />
    <bpmn:inclusiveGateway id="Join" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fx" sourceRef="Split" targetRef="X">${cond('a === true')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fy" sourceRef="Split" targetRef="Y">${cond('b === true')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fDef" sourceRef="Split" targetRef="Z" />
    <bpmn:sequenceFlow id="fx2" sourceRef="X" targetRef="Join" />
    <bpmn:sequenceFlow id="fy2" sourceRef="Y" targetRef="Join" />
    <bpmn:sequenceFlow id="fz2" sourceRef="Z" targetRef="Join" />
    <bpmn:sequenceFlow id="fj" sourceRef="Join" targetRef="End" />`);

export const EVENT_BASED = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:eventBasedGateway id="Gw" />
    <bpmn:intermediateCatchEvent id="OnApproved">
      <bpmn:messageEventDefinition />
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="OnRejected">
      <bpmn:messageEventDefinition />
    </bpmn:intermediateCatchEvent>
    <bpmn:task id="Ship" />
    <bpmn:task id="Cancel" />
    <bpmn:endEvent id="EndA" />
    <bpmn:endEvent id="EndB" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Gw" />
    <bpmn:sequenceFlow id="fa" sourceRef="Gw" targetRef="OnApproved" />
    <bpmn:sequenceFlow id="fb" sourceRef="Gw" targetRef="OnRejected" />
    <bpmn:sequenceFlow id="fa2" sourceRef="OnApproved" targetRef="Ship" />
    <bpmn:sequenceFlow id="fb2" sourceRef="OnRejected" targetRef="Cancel" />
    <bpmn:sequenceFlow id="fa3" sourceRef="Ship" targetRef="EndA" />
    <bpmn:sequenceFlow id="fb3" sourceRef="Cancel" targetRef="EndB" />`);

export const BOUNDARY_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:error id="Err" name="PaymentFailed" errorCode="PAYMENT_FAILED" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Pay" name="Take payment" />
    <bpmn:boundaryEvent id="OnFail" attachedToRef="Pay">
      <bpmn:errorEventDefinition errorRef="Err" />
    </bpmn:boundaryEvent>
    <bpmn:task id="Fulfil" />
    <bpmn:task id="Refund" />
    <bpmn:endEvent id="EndOk" />
    <bpmn:endEvent id="EndFail" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Pay" />
    <bpmn:sequenceFlow id="f1" sourceRef="Pay" targetRef="Fulfil" />
    <bpmn:sequenceFlow id="f2" sourceRef="Fulfil" targetRef="EndOk" />
    <bpmn:sequenceFlow id="fb" sourceRef="OnFail" targetRef="Refund" />
    <bpmn:sequenceFlow id="fb2" sourceRef="Refund" targetRef="EndFail" />
  </bpmn:process>
</bpmn:definitions>`;

export const SUBPROCESS = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:subProcess id="Sub" name="Review">
      <bpmn:startEvent id="SubStart" />
      <bpmn:serviceTask id="Inner" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="s1" sourceRef="SubStart" targetRef="Inner" />
      <bpmn:sequenceFlow id="s2" sourceRef="Inner" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:task id="After" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Sub" />
    <bpmn:sequenceFlow id="f1" sourceRef="Sub" targetRef="After" />
    <bpmn:sequenceFlow id="f2" sourceRef="After" targetRef="End" />`);

export const TERMINATE = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:userTask id="Work" />
    <bpmn:endEvent id="Stop">
      <bpmn:terminateEventDefinition />
    </bpmn:endEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="Work" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="Stop" />
    <bpmn:sequenceFlow id="fa2" sourceRef="Work" targetRef="End" />`);

export const CATCH_WAIT = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="WaitMsg">
      <bpmn:messageEventDefinition />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="WaitMsg" />
    <bpmn:sequenceFlow id="f1" sourceRef="WaitMsg" targetRef="End" />`);

export const BOUNDARY_NON_INTERRUPTING = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:signal id="Sig" name="Escalated" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Work" />
    <bpmn:boundaryEvent id="OnPing" attachedToRef="Work" cancelActivity="false">
      <bpmn:signalEventDefinition signalRef="Sig" />
    </bpmn:boundaryEvent>
    <bpmn:task id="Notify" />
    <bpmn:endEvent id="EndNotify" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Work" />
    <bpmn:sequenceFlow id="f1" sourceRef="Work" targetRef="End" />
    <bpmn:sequenceFlow id="fb" sourceRef="OnPing" targetRef="Notify" />
    <bpmn:sequenceFlow id="fb2" sourceRef="Notify" targetRef="EndNotify" />
  </bpmn:process>
</bpmn:definitions>`;

export const SUBPROCESS_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:error id="Err" name="OutOfStock" errorCode="OUT_OF_STOCK" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubStart" />
      <bpmn:exclusiveGateway id="SubGw" default="sFail" />
      <bpmn:endEvent id="SubOk" />
      <bpmn:endEvent id="SubFail">
        <bpmn:errorEventDefinition errorRef="Err" />
      </bpmn:endEvent>
      <bpmn:sequenceFlow id="s0" sourceRef="SubStart" targetRef="SubGw" />
      <bpmn:sequenceFlow id="sOk" sourceRef="SubGw" targetRef="SubOk">${cond('ok === true')}</bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="sFail" sourceRef="SubGw" targetRef="SubFail" />
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="OnSubError" attachedToRef="Sub">
      <bpmn:errorEventDefinition errorRef="Err" />
    </bpmn:boundaryEvent>
    <bpmn:task id="After" />
    <bpmn:task id="Recover" />
    <bpmn:endEvent id="End" />
    <bpmn:endEvent id="EndRecovered" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Sub" />
    <bpmn:sequenceFlow id="f1" sourceRef="Sub" targetRef="After" />
    <bpmn:sequenceFlow id="f2" sourceRef="After" targetRef="End" />
    <bpmn:sequenceFlow id="fb" sourceRef="OnSubError" targetRef="Recover" />
    <bpmn:sequenceFlow id="fb2" sourceRef="Recover" targetRef="EndRecovered" />
  </bpmn:process>
</bpmn:definitions>`;

export const SUBPROCESS_TERMINATE = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubStart" />
      <bpmn:parallelGateway id="SubSplit" />
      <bpmn:userTask id="SubWork" />
      <bpmn:endEvent id="SubStop">
        <bpmn:terminateEventDefinition />
      </bpmn:endEvent>
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="s0" sourceRef="SubStart" targetRef="SubSplit" />
      <bpmn:sequenceFlow id="sa" sourceRef="SubSplit" targetRef="SubWork" />
      <bpmn:sequenceFlow id="sb" sourceRef="SubSplit" targetRef="SubStop" />
      <bpmn:sequenceFlow id="sa2" sourceRef="SubWork" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:task id="After" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Sub" />
    <bpmn:sequenceFlow id="f1" sourceRef="Sub" targetRef="After" />
    <bpmn:sequenceFlow id="f2" sourceRef="After" targetRef="End" />`);

export const ENDLESS_LOOP = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:task id="Spin" />
    <bpmn:exclusiveGateway id="Again" default="fBack" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Spin" />
    <bpmn:sequenceFlow id="f1" sourceRef="Spin" targetRef="Again" />
    <bpmn:sequenceFlow id="fBack" sourceRef="Again" targetRef="Spin" />`);

/** A parallel join starved by an exclusive split above it: `Join` never sees a token on `fb2`. */
export const PARALLEL_DEADLOCK = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:exclusiveGateway id="Split" default="fb" />
    <bpmn:task id="A" />
    <bpmn:task id="B" />
    <bpmn:parallelGateway id="Join" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="A">${cond('go === true')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="B" />
    <bpmn:sequenceFlow id="fa2" sourceRef="A" targetRef="Join" />
    <bpmn:sequenceFlow id="fb2" sourceRef="B" targetRef="Join" />
    <bpmn:sequenceFlow id="fj" sourceRef="Join" targetRef="End" />`);

/** `Lost` and `Orphan` form their own island, disconnected from `Start`. */
export const UNREACHABLE_ISLAND = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:task id="Main" />
    <bpmn:endEvent id="End" />
    <bpmn:task id="Lost" />
    <bpmn:task id="Orphan" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Main" />
    <bpmn:sequenceFlow id="f1" sourceRef="Main" targetRef="End" />
    <bpmn:sequenceFlow id="fx" sourceRef="Lost" targetRef="Orphan" />`);

/** `Gw` has no default and both flows are conditional: nothing to fall back to. */
export const EXCLUSIVE_NO_DEFAULT = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:exclusiveGateway id="Gw" />
    <bpmn:task id="High" />
    <bpmn:task id="Low" />
    <bpmn:endEvent id="EndHigh" />
    <bpmn:endEvent id="EndLow" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Gw" />
    <bpmn:sequenceFlow id="fHigh" sourceRef="Gw" targetRef="High">${cond('amount &gt; 100')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fLow" sourceRef="Gw" targetRef="Low">${cond('amount &lt;= 100')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fh2" sourceRef="High" targetRef="EndHigh" />
    <bpmn:sequenceFlow id="fl2" sourceRef="Low" targetRef="EndLow" />`);

/**
 * A gateway whose guard only the `javascript` mode understands: the safe
 * evaluator refuses an arrow function, so under `safe` the condition reads as
 * `undefined` and the token leaves through the default flow. The user task in
 * front of it is what lets a test park, persist and restore before the gateway
 * decides.
 */
export const JS_CONDITION_AFTER_WAIT = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Review" name="Review basket" />
    <bpmn:exclusiveGateway id="Gw" default="fNone" />
    <bpmn:task id="Big" />
    <bpmn:task id="None" />
    <bpmn:endEvent id="EndBig" />
    <bpmn:endEvent id="EndNone" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Review" />
    <bpmn:sequenceFlow id="f1" sourceRef="Review" targetRef="Gw" />
    <bpmn:sequenceFlow id="fBig" sourceRef="Gw" targetRef="Big">${cond('itens.some((i) =&gt; i &gt; 2)')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fNone" sourceRef="Gw" targetRef="None" />
    <bpmn:sequenceFlow id="fb2" sourceRef="Big" targetRef="EndBig" />
    <bpmn:sequenceFlow id="fn2" sourceRef="None" targetRef="EndNone" />`);

export const PARALLEL_WAIT = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:userTask id="TaskA" />
    <bpmn:userTask id="TaskB" />
    <bpmn:parallelGateway id="Join" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="TaskA" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="TaskB" />
    <bpmn:sequenceFlow id="fa2" sourceRef="TaskA" targetRef="Join" />
    <bpmn:sequenceFlow id="fb2" sourceRef="TaskB" targetRef="Join" />
    <bpmn:sequenceFlow id="fj" sourceRef="Join" targetRef="End" />`);

export const SUBPROCESS_WAIT = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:subProcess id="Sub" name="Review">
      <bpmn:startEvent id="SubStart" />
      <bpmn:userTask id="Review" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="s1" sourceRef="SubStart" targetRef="Review" />
      <bpmn:sequenceFlow id="s2" sourceRef="Review" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:task id="After" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Sub" />
    <bpmn:sequenceFlow id="f1" sourceRef="Sub" targetRef="After" />
    <bpmn:sequenceFlow id="f2" sourceRef="After" targetRef="End" />`);

export const MI_COLLECTION = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:dataObject id="itens" name="itens" />
    <bpmn:dataObject id="resultados" name="resultados" />
    <bpmn:serviceTask id="Handle" name="Handle item">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopDataInputRef>itens</bpmn:loopDataInputRef>
        <bpmn:inputDataItem id="item" name="item" />
        <bpmn:loopDataOutputRef>resultados</bpmn:loopDataOutputRef>
        <bpmn:outputDataItem id="resultado" name="resultado" />
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Handle" />
    <bpmn:sequenceFlow id="f1" sourceRef="Handle" targetRef="End" />`);

export const MI_PARALLEL_USER_TASKS = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:dataObject id="aprovadores" name="aprovadores" />
    <bpmn:userTask id="Approve" name="Approve">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopDataInputRef>aprovadores</bpmn:loopDataInputRef>
        <bpmn:inputDataItem id="aprovador" name="aprovador" />
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:userTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Approve" />
    <bpmn:sequenceFlow id="f1" sourceRef="Approve" targetRef="End" />`);

export const MI_PARALLEL_COLLECTION = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:dataObject id="itens" name="itens" />
    <bpmn:dataObject id="resultados" name="resultados" />
    <bpmn:userTask id="Handle" name="Handle item">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopDataInputRef>itens</bpmn:loopDataInputRef>
        <bpmn:inputDataItem id="item" name="item" />
        <bpmn:loopDataOutputRef>resultados</bpmn:loopDataOutputRef>
        <bpmn:outputDataItem id="resultado" name="resultado" />
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:userTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Handle" />
    <bpmn:sequenceFlow id="f1" sourceRef="Handle" targetRef="End" />`);

/** Same as {@link MI_PARALLEL_COLLECTION}, but stops after two results. */
export const MI_PARALLEL_PARTIAL = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:dataObject id="itens" name="itens" />
    <bpmn:dataObject id="resultados" name="resultados" />
    <bpmn:userTask id="Handle" name="Handle item">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopDataInputRef>itens</bpmn:loopDataInputRef>
        <bpmn:inputDataItem id="item" name="item" />
        <bpmn:loopDataOutputRef>resultados</bpmn:loopDataOutputRef>
        <bpmn:outputDataItem id="resultado" name="resultado" />
        <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">resultados.length &gt;= 2</bpmn:completionCondition>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:userTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Handle" />
    <bpmn:sequenceFlow id="f1" sourceRef="Handle" targetRef="End" />`);

export const MI_SEQUENTIAL = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Step" name="Step">
      <bpmn:multiInstanceLoopCharacteristics isSequential="true">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:userTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Step" />
    <bpmn:sequenceFlow id="f1" sourceRef="Step" targetRef="End" />`);

export const MI_COMPLETION_CONDITION = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Try" name="Try">
      <bpmn:multiInstanceLoopCharacteristics isSequential="true">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">10</bpmn:loopCardinality>
        <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">encontrado === true</bpmn:completionCondition>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Try" />
    <bpmn:sequenceFlow id="f1" sourceRef="Try" targetRef="End" />`);

export const MI_SUBPROCESS = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:dataObject id="pedidos" name="pedidos" />
    <bpmn:subProcess id="Handle" name="Handle order">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopDataInputRef>pedidos</bpmn:loopDataInputRef>
        <bpmn:inputDataItem id="pedido" name="pedido" />
      </bpmn:multiInstanceLoopCharacteristics>
      <bpmn:startEvent id="SubStart" />
      <bpmn:serviceTask id="Charge" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="s1" sourceRef="SubStart" targetRef="Charge" />
      <bpmn:sequenceFlow id="s2" sourceRef="Charge" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Handle" />
    <bpmn:sequenceFlow id="f1" sourceRef="Handle" targetRef="End" />`);

export const STANDARD_LOOP = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Retry" name="Retry">
      <bpmn:standardLoopCharacteristics testBefore="true" loopMaximum="5">
        <bpmn:loopCondition xsi:type="bpmn:tFormalExpression">pago !== true</bpmn:loopCondition>
      </bpmn:standardLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Retry" />
    <bpmn:sequenceFlow id="f1" sourceRef="Retry" targetRef="End" />`);

export const TIMER_CATCH = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Wait5m" name="Aguardar 5 min">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT5M</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:task id="After" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Wait5m" />
    <bpmn:sequenceFlow id="f1" sourceRef="Wait5m" targetRef="After" />
    <bpmn:sequenceFlow id="f2" sourceRef="After" targetRef="End" />`);

export const TIMER_BOUNDARY = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Approve" name="Aprovar" />
    <bpmn:boundaryEvent id="Deadline" attachedToRef="Approve">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT2H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:task id="Escalate" name="Escalar" />
    <bpmn:endEvent id="EndEscalated" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Approve" />
    <bpmn:sequenceFlow id="f1" sourceRef="Approve" targetRef="End" />
    <bpmn:sequenceFlow id="fb" sourceRef="Deadline" targetRef="Escalate" />
    <bpmn:sequenceFlow id="fb2" sourceRef="Escalate" targetRef="EndEscalated" />`);

export const LANES_AND_ROLES = wrap(`
    <bpmn:laneSet id="Lanes">
      <bpmn:lane id="LaneVendas" name="Vendas">
        <bpmn:flowNodeRef>Start</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Registrar</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="LaneFinanceiro" name="Financeiro">
        <bpmn:flowNodeRef>Aprovar</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>End</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Registrar" name="Registrar pedido" />
    <bpmn:userTask id="Aprovar" name="Aprovar pagamento">
      <bpmn:potentialOwner>
        <bpmn:resourceAssignmentExpression>
          <bpmn:formalExpression>gerentes, diretoria</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>
      </bpmn:potentialOwner>
    </bpmn:userTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Registrar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Registrar" targetRef="Aprovar" />
    <bpmn:sequenceFlow id="f2" sourceRef="Aprovar" targetRef="End" />`);

export const LINK_EVENTS = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:task id="Prepare" />
    <bpmn:intermediateThrowEvent id="GoTo">
      <bpmn:linkEventDefinition name="Continua" />
    </bpmn:intermediateThrowEvent>
    <bpmn:task id="Skipped" />
    <bpmn:intermediateCatchEvent id="Here">
      <bpmn:linkEventDefinition name="Continua" />
    </bpmn:intermediateCatchEvent>
    <bpmn:task id="Finish" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Prepare" />
    <bpmn:sequenceFlow id="f1" sourceRef="Prepare" targetRef="GoTo" />
    <bpmn:sequenceFlow id="f2" sourceRef="Here" targetRef="Finish" />
    <bpmn:sequenceFlow id="f3" sourceRef="Finish" targetRef="End" />
    <bpmn:sequenceFlow id="f4" sourceRef="Skipped" targetRef="End" />`);

export const SIGNAL_BROADCAST = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:signal id="Sig" name="Publicado" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:intermediateCatchEvent id="WaitA">
      <bpmn:signalEventDefinition signalRef="Sig" />
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitB">
      <bpmn:signalEventDefinition signalRef="Sig" />
    </bpmn:intermediateCatchEvent>
    <bpmn:parallelGateway id="Join" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="WaitA" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="WaitB" />
    <bpmn:sequenceFlow id="fa2" sourceRef="WaitA" targetRef="Join" />
    <bpmn:sequenceFlow id="fb2" sourceRef="WaitB" targetRef="Join" />
    <bpmn:sequenceFlow id="fj" sourceRef="Join" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

export const EVENT_SUBPROCESS_SIGNAL = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:signal id="Sig" name="PedidoCancelado" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Work" name="Separar pedido" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Work" />
    <bpmn:sequenceFlow id="f1" sourceRef="Work" targetRef="End" />
    <bpmn:subProcess id="OnCancel" triggeredByEvent="true">
      <bpmn:startEvent id="CancelStart" isInterrupting="true">
        <bpmn:signalEventDefinition signalRef="Sig" />
      </bpmn:startEvent>
      <bpmn:serviceTask id="Refund" name="Estornar" />
      <bpmn:endEvent id="CancelEnd" />
      <bpmn:sequenceFlow id="c1" sourceRef="CancelStart" targetRef="Refund" />
      <bpmn:sequenceFlow id="c2" sourceRef="Refund" targetRef="CancelEnd" />
    </bpmn:subProcess>
  </bpmn:process>
</bpmn:definitions>`;

export const EVENT_SUBPROCESS_NON_INTERRUPTING = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:signal id="Sig" name="ClientePerguntou" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Work" name="Produzir" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Work" />
    <bpmn:sequenceFlow id="f1" sourceRef="Work" targetRef="End" />
    <bpmn:subProcess id="OnQuestion" triggeredByEvent="true">
      <bpmn:startEvent id="QuestionStart" isInterrupting="false">
        <bpmn:signalEventDefinition signalRef="Sig" />
      </bpmn:startEvent>
      <bpmn:serviceTask id="Answer" name="Responder" />
      <bpmn:endEvent id="QuestionEnd" />
      <bpmn:sequenceFlow id="q1" sourceRef="QuestionStart" targetRef="Answer" />
      <bpmn:sequenceFlow id="q2" sourceRef="Answer" targetRef="QuestionEnd" />
    </bpmn:subProcess>
  </bpmn:process>
</bpmn:definitions>`;

export const EVENT_SUBPROCESS_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:error id="Err" name="SemEstoque" errorCode="SEM_ESTOQUE" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Reserve" name="Reservar" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Reserve" />
    <bpmn:sequenceFlow id="f1" sourceRef="Reserve" targetRef="End" />
    <bpmn:subProcess id="OnError" triggeredByEvent="true">
      <bpmn:startEvent id="ErrorStart">
        <bpmn:errorEventDefinition errorRef="Err" />
      </bpmn:startEvent>
      <bpmn:serviceTask id="Notify" name="Avisar comprador" />
      <bpmn:endEvent id="ErrorEnd" />
      <bpmn:sequenceFlow id="e1" sourceRef="ErrorStart" targetRef="Notify" />
      <bpmn:sequenceFlow id="e2" sourceRef="Notify" targetRef="ErrorEnd" />
    </bpmn:subProcess>
  </bpmn:process>
</bpmn:definitions>`;

export const MI_WITH_BOUNDARY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:signal id="Sig" name="Cancelar" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:dataObject id="itens" name="itens" />
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Aprovar">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopDataInputRef>itens</bpmn:loopDataInputRef>
        <bpmn:inputDataItem id="item" name="item" />
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:userTask>
    <bpmn:boundaryEvent id="OnCancel" attachedToRef="Aprovar">
      <bpmn:signalEventDefinition signalRef="Sig" />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="OnDeadline" attachedToRef="Aprovar">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:task id="Abortar" />
    <bpmn:task id="Escalar" />
    <bpmn:endEvent id="EndAbort" />
    <bpmn:endEvent id="EndEscalate" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aprovar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aprovar" targetRef="End" />
    <bpmn:sequenceFlow id="fc" sourceRef="OnCancel" targetRef="Abortar" />
    <bpmn:sequenceFlow id="fc2" sourceRef="Abortar" targetRef="EndAbort" />
    <bpmn:sequenceFlow id="fd" sourceRef="OnDeadline" targetRef="Escalar" />
    <bpmn:sequenceFlow id="fd2" sourceRef="Escalar" targetRef="EndEscalate" />
  </bpmn:process>
</bpmn:definitions>`;

export const TERMINATE_WITH_MI = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:dataObject id="itens" name="itens" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:userTask id="Trabalhar">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopDataInputRef>itens</bpmn:loopDataInputRef>
        <bpmn:inputDataItem id="item" name="item" />
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:userTask>
    <bpmn:endEvent id="Stop">
      <bpmn:terminateEventDefinition />
    </bpmn:endEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="Trabalhar" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="Stop" />
    <bpmn:sequenceFlow id="fa2" sourceRef="Trabalhar" targetRef="End" />`);

export const CONDITIONAL_CATCH = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:userTask id="Depositar" />
    <bpmn:intermediateCatchEvent id="SaldoOk">
      <bpmn:conditionalEventDefinition>
        <bpmn:condition xsi:type="bpmn:tFormalExpression">saldo &gt;= 100</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:task id="Liberar" />
    <bpmn:endEvent id="End" />
    <bpmn:endEvent id="EndDep" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="Depositar" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="SaldoOk" />
    <bpmn:sequenceFlow id="fa2" sourceRef="Depositar" targetRef="EndDep" />
    <bpmn:sequenceFlow id="fb2" sourceRef="SaldoOk" targetRef="Liberar" />
    <bpmn:sequenceFlow id="fb3" sourceRef="Liberar" targetRef="End" />`);

export const COMPLEX_GATEWAY = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:userTask id="VotoA" />
    <bpmn:userTask id="VotoB" />
    <bpmn:userTask id="VotoC" />
    <bpmn:complexGateway id="Quorum">
      <bpmn:activationCondition xsi:type="bpmn:tFormalExpression">arrived &gt;= 2</bpmn:activationCondition>
    </bpmn:complexGateway>
    <bpmn:task id="Decidir" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="VotoA" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="VotoB" />
    <bpmn:sequenceFlow id="fc" sourceRef="Split" targetRef="VotoC" />
    <bpmn:sequenceFlow id="fa2" sourceRef="VotoA" targetRef="Quorum" />
    <bpmn:sequenceFlow id="fb2" sourceRef="VotoB" targetRef="Quorum" />
    <bpmn:sequenceFlow id="fc2" sourceRef="VotoC" targetRef="Quorum" />
    <bpmn:sequenceFlow id="fq" sourceRef="Quorum" targetRef="Decidir" />
    <bpmn:sequenceFlow id="fd" sourceRef="Decidir" targetRef="End" />`);

export const MULTI_EVENT_DEFINITIONS = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:message id="Msg" name="RespostaCliente" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Aguardar" />
    <bpmn:boundaryEvent id="MsgOuPrazo" attachedToRef="Aguardar">
      <bpmn:messageEventDefinition messageRef="Msg" />
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT30M</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:task id="Seguir" />
    <bpmn:endEvent id="End" />
    <bpmn:endEvent id="EndAlt" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aguardar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aguardar" targetRef="End" />
    <bpmn:sequenceFlow id="fb" sourceRef="MsgOuPrazo" targetRef="Seguir" />
    <bpmn:sequenceFlow id="fb2" sourceRef="Seguir" targetRef="EndAlt" />
  </bpmn:process>
</bpmn:definitions>`;

export const CALL_ACTIVITY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:process id="Cobranca" isExecutable="true" name="Cobrança">
    <bpmn:startEvent id="CobrancaStart" />
    <bpmn:serviceTask id="Cobrar" name="Cobrar cartão" />
    <bpmn:userTask id="ConfirmarCobranca" name="Confirmar cobrança" />
    <bpmn:endEvent id="CobrancaEnd" />
    <bpmn:sequenceFlow id="c1" sourceRef="CobrancaStart" targetRef="Cobrar" />
    <bpmn:sequenceFlow id="c2" sourceRef="Cobrar" targetRef="ConfirmarCobranca" />
    <bpmn:sequenceFlow id="c3" sourceRef="ConfirmarCobranca" targetRef="CobrancaEnd" />
  </bpmn:process>
  <bpmn:process id="Pedido" isExecutable="true" name="Pedido">
    <bpmn:startEvent id="Start" />
    <bpmn:callActivity id="Chamar" name="Cobrar do cliente" calledElement="Cobranca" />
    <bpmn:task id="Enviar" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Chamar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Chamar" targetRef="Enviar" />
    <bpmn:sequenceFlow id="f2" sourceRef="Enviar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

export const COMPENSATION = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="ReservarVoo" name="Reservar voo" />
    <bpmn:boundaryEvent id="CompVoo" attachedToRef="ReservarVoo">
      <bpmn:compensateEventDefinition />
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="CancelarVoo" name="Cancelar voo" isForCompensation="true" />
    <bpmn:serviceTask id="ReservarHotel" name="Reservar hotel" />
    <bpmn:boundaryEvent id="CompHotel" attachedToRef="ReservarHotel">
      <bpmn:compensateEventDefinition />
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="CancelarHotel" name="Cancelar hotel" isForCompensation="true" />
    <bpmn:exclusiveGateway id="Pagou" default="fFalhou" />
    <bpmn:endEvent id="ViagemOk" />
    <bpmn:intermediateThrowEvent id="Desfazer">
      <bpmn:compensateEventDefinition />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="ViagemCancelada" />
    <bpmn:association id="a1" sourceRef="CompVoo" targetRef="CancelarVoo" />
    <bpmn:association id="a2" sourceRef="CompHotel" targetRef="CancelarHotel" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="ReservarVoo" />
    <bpmn:sequenceFlow id="f1" sourceRef="ReservarVoo" targetRef="ReservarHotel" />
    <bpmn:sequenceFlow id="f2" sourceRef="ReservarHotel" targetRef="Pagou" />
    <bpmn:sequenceFlow id="fOk" sourceRef="Pagou" targetRef="ViagemOk">${cond('pago === true')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fFalhou" sourceRef="Pagou" targetRef="Desfazer" />
    <bpmn:sequenceFlow id="f3" sourceRef="Desfazer" targetRef="ViagemCancelada" />`);

export const TRANSACTION_CANCEL = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:transaction id="Reserva" name="Reserva">
      <bpmn:startEvent id="TxStart" />
      <bpmn:serviceTask id="Debitar" name="Debitar cartão" />
      <bpmn:boundaryEvent id="CompDebito" attachedToRef="Debitar">
        <bpmn:compensateEventDefinition />
      </bpmn:boundaryEvent>
      <bpmn:serviceTask id="Estornar" name="Estornar" isForCompensation="true" />
      <bpmn:exclusiveGateway id="Confirmou" default="fCancel" />
      <bpmn:endEvent id="TxOk" />
      <bpmn:endEvent id="TxCancel">
        <bpmn:cancelEventDefinition />
      </bpmn:endEvent>
      <bpmn:association id="ta1" sourceRef="CompDebito" targetRef="Estornar" />
      <bpmn:sequenceFlow id="t0" sourceRef="TxStart" targetRef="Debitar" />
      <bpmn:sequenceFlow id="t1" sourceRef="Debitar" targetRef="Confirmou" />
      <bpmn:sequenceFlow id="tOk" sourceRef="Confirmou" targetRef="TxOk">${cond('confirmado === true')}</bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="fCancel" sourceRef="Confirmou" targetRef="TxCancel" />
    </bpmn:transaction>
    <bpmn:boundaryEvent id="TxCancelada" attachedToRef="Reserva">
      <bpmn:cancelEventDefinition />
    </bpmn:boundaryEvent>
    <bpmn:task id="AvisarCliente" />
    <bpmn:task id="Concluir" />
    <bpmn:endEvent id="End" />
    <bpmn:endEvent id="EndCancelado" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Reserva" />
    <bpmn:sequenceFlow id="f1" sourceRef="Reserva" targetRef="Concluir" />
    <bpmn:sequenceFlow id="f2" sourceRef="Concluir" targetRef="End" />
    <bpmn:sequenceFlow id="fb" sourceRef="TxCancelada" targetRef="AvisarCliente" />
    <bpmn:sequenceFlow id="fb2" sourceRef="AvisarCliente" targetRef="EndCancelado" />`);

export const ESCALATION = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:escalation id="Esc" name="ValorAlto" escalationCode="VALOR_ALTO" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:subProcess id="Analise" name="Análise">
      <bpmn:startEvent id="SubStart" />
      <bpmn:serviceTask id="Avaliar" name="Avaliar" />
      <bpmn:intermediateThrowEvent id="Escalar">
        <bpmn:escalationEventDefinition escalationRef="Esc" />
      </bpmn:intermediateThrowEvent>
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="s0" sourceRef="SubStart" targetRef="Avaliar" />
      <bpmn:sequenceFlow id="s1" sourceRef="Avaliar" targetRef="Escalar" />
      <bpmn:sequenceFlow id="s2" sourceRef="Escalar" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="OnEscalation" attachedToRef="Analise" cancelActivity="false">
      <bpmn:escalationEventDefinition escalationRef="Esc" />
    </bpmn:boundaryEvent>
    <bpmn:task id="AvisarDiretoria" name="Avisar diretoria" />
    <bpmn:task id="Continuar" />
    <bpmn:endEvent id="EndAviso" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Analise" />
    <bpmn:sequenceFlow id="f1" sourceRef="Analise" targetRef="Continuar" />
    <bpmn:sequenceFlow id="f2" sourceRef="Continuar" targetRef="End" />
    <bpmn:sequenceFlow id="fb" sourceRef="OnEscalation" targetRef="AvisarDiretoria" />
    <bpmn:sequenceFlow id="fb2" sourceRef="AvisarDiretoria" targetRef="EndAviso" />
  </bpmn:process>
</bpmn:definitions>`;

export const RECEIVE_TASK = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:message id="Msg" name="PagamentoConfirmado" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:receiveTask id="AguardarPagamento" name="Aguardar pagamento" messageRef="Msg" />
    <bpmn:task id="Enviar" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="AguardarPagamento" />
    <bpmn:sequenceFlow id="f1" sourceRef="AguardarPagamento" targetRef="Enviar" />
    <bpmn:sequenceFlow id="f2" sourceRef="Enviar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

export const THROW_SIGNAL = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:signal id="Sig" name="PedidoPago" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:userTask id="Cobrar" />
    <bpmn:intermediateThrowEvent id="Avisar">
      <bpmn:signalEventDefinition signalRef="Sig" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="EndCobranca" />
    <bpmn:intermediateCatchEvent id="EsperarPagamento">
      <bpmn:signalEventDefinition signalRef="Sig" />
    </bpmn:intermediateCatchEvent>
    <bpmn:task id="EmitirNota" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="Cobrar" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="EsperarPagamento" />
    <bpmn:sequenceFlow id="fa2" sourceRef="Cobrar" targetRef="Avisar" />
    <bpmn:sequenceFlow id="fa3" sourceRef="Avisar" targetRef="EndCobranca" />
    <bpmn:sequenceFlow id="fb2" sourceRef="EsperarPagamento" targetRef="EmitirNota" />
    <bpmn:sequenceFlow id="fb3" sourceRef="EmitirNota" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

export const CONDITIONAL_BOUNDARY = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:userTask id="Analisar" />
    <bpmn:boundaryEvent id="FicouUrgente" attachedToRef="Analisar" cancelActivity="false">
      <bpmn:conditionalEventDefinition>
        <bpmn:condition xsi:type="bpmn:tFormalExpression">urgente === true</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:userTask id="Sinalizar" />
    <bpmn:task id="Priorizar" />
    <bpmn:endEvent id="EndUrgente" />
    <bpmn:endEvent id="EndSinal" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="Analisar" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="Sinalizar" />
    <bpmn:sequenceFlow id="fa2" sourceRef="Analisar" targetRef="End" />
    <bpmn:sequenceFlow id="fb2" sourceRef="Sinalizar" targetRef="EndSinal" />
    <bpmn:sequenceFlow id="fc" sourceRef="FicouUrgente" targetRef="Priorizar" />
    <bpmn:sequenceFlow id="fc2" sourceRef="Priorizar" targetRef="EndUrgente" />`);

export const TIMER_CYCLE = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Aguardar" />
    <bpmn:boundaryEvent id="Lembrete" attachedToRef="Aguardar" cancelActivity="false">
      <bpmn:timerEventDefinition>
        <bpmn:timeCycle xsi:type="bpmn:tFormalExpression">R3/PT1H</bpmn:timeCycle>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="Cobrar" />
    <bpmn:endEvent id="EndLembrete" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aguardar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aguardar" targetRef="End" />
    <bpmn:sequenceFlow id="fb" sourceRef="Lembrete" targetRef="Cobrar" />
    <bpmn:sequenceFlow id="fb2" sourceRef="Cobrar" targetRef="EndLembrete" />`);

export const AD_HOC = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:adHocSubProcess id="Atendimento" ordering="Parallel">
      <bpmn:serviceTask id="Ligar" />
      <bpmn:serviceTask id="Enviar" />
      <bpmn:serviceTask id="Registrar" />
      <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">resolvido === true</bpmn:completionCondition>
    </bpmn:adHocSubProcess>
    <bpmn:task id="Fechar" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Atendimento" />
    <bpmn:sequenceFlow id="f1" sourceRef="Atendimento" targetRef="Fechar" />
    <bpmn:sequenceFlow id="f2" sourceRef="Fechar" targetRef="End" />`);

export const AD_HOC_SEQUENTIAL = wrap(`
    <bpmn:startEvent id="Start" />
    <bpmn:adHocSubProcess id="Checklist" ordering="Sequential">
      <bpmn:userTask id="Item1" />
      <bpmn:userTask id="Item2" />
    </bpmn:adHocSubProcess>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Checklist" />
    <bpmn:sequenceFlow id="f1" sourceRef="Checklist" targetRef="End" />`);

export const DATA_MAPPING = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:process id="Cobranca" isExecutable="true">
    <bpmn:startEvent id="CStart" />
    <bpmn:serviceTask id="Cobrar" />
    <bpmn:userTask id="Confirmar" />
    <bpmn:endEvent id="CEnd" />
    <bpmn:sequenceFlow id="c1" sourceRef="CStart" targetRef="Cobrar" />
    <bpmn:sequenceFlow id="c2" sourceRef="Cobrar" targetRef="Confirmar" />
    <bpmn:sequenceFlow id="c3" sourceRef="Confirmar" targetRef="CEnd" />
  </bpmn:process>
  <bpmn:process id="Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:callActivity id="Chamar" calledElement="Cobranca">
      <bpmn:dataInputAssociation id="in1">
        <bpmn:assignment>
          <bpmn:from>valorPedido</bpmn:from>
          <bpmn:to>valor</bpmn:to>
        </bpmn:assignment>
      </bpmn:dataInputAssociation>
      <bpmn:dataOutputAssociation id="out1">
        <bpmn:assignment>
          <bpmn:from>recibo</bpmn:from>
          <bpmn:to>reciboDaCobranca</bpmn:to>
        </bpmn:assignment>
      </bpmn:dataOutputAssociation>
    </bpmn:callActivity>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Chamar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Chamar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

/**
 * Collaboration whose first pool is a black box (`isExecutable="false"`), as
 * BPMN tools routinely emit when the counterpart is an external party.
 */
export const COLLABORATION_BLACKBOX_FIRST = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:collaboration id="Collab">
    <bpmn:participant id="PartBlack" name="BlackBox" processRef="BlackBox" />
    <bpmn:participant id="PartMain" name="Loja" processRef="Main" />
  </bpmn:collaboration>
  <bpmn:process id="BlackBox" isExecutable="false" />
  <bpmn:process id="Main" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:task id="Work" name="Trabalho" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Work" />
    <bpmn:sequenceFlow id="f2" sourceRef="Work" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

/** Every pool is a black box: nothing in the file can be executed. */
export const COLLABORATION_ALL_BLACKBOX = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:collaboration id="Collab">
    <bpmn:participant id="PartA" name="Cliente" processRef="A" />
  </bpmn:collaboration>
  <bpmn:process id="A" name="Cliente" isExecutable="false">
    <bpmn:startEvent id="Start" />
  </bpmn:process>
</bpmn:definitions>`;

/**
 * A catch event and a boundary event that both declare two message triggers and
 * ask for `parallelMultiple`: the spec requires every trigger to arrive.
 */
export const PARALLEL_MULTIPLE = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:message id="MsgPago" name="pago" />
  <bpmn:message id="MsgNota" name="nota" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Aguardar" parallelMultiple="true">
      <bpmn:messageEventDefinition messageRef="MsgPago" />
      <bpmn:messageEventDefinition messageRef="MsgNota" />
    </bpmn:intermediateCatchEvent>
    <bpmn:task id="Expedir" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aguardar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aguardar" targetRef="Expedir" />
    <bpmn:sequenceFlow id="f2" sourceRef="Expedir" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

/** Same triggers, without `parallelMultiple`: the first one that lands fires. */
export const ANY_MULTIPLE = PARALLEL_MULTIPLE.replace(' parallelMultiple="true"', '');

/** Boundary event that only interrupts once both triggers arrived. */
export const PARALLEL_MULTIPLE_BOUNDARY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:message id="MsgPago" name="pago" />
  <bpmn:message id="MsgNota" name="nota" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Conferir" />
    <bpmn:boundaryEvent id="Ambos" attachedToRef="Conferir" parallelMultiple="true">
      <bpmn:messageEventDefinition messageRef="MsgPago" />
      <bpmn:messageEventDefinition messageRef="MsgNota" />
    </bpmn:boundaryEvent>
    <bpmn:task id="Acelerar" />
    <bpmn:endEvent id="End" />
    <bpmn:endEvent id="EndAlt" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Conferir" />
    <bpmn:sequenceFlow id="f1" sourceRef="Conferir" targetRef="End" />
    <bpmn:sequenceFlow id="fb" sourceRef="Ambos" targetRef="Acelerar" />
    <bpmn:sequenceFlow id="fb2" sourceRef="Acelerar" targetRef="EndAlt" />
  </bpmn:process>
</bpmn:definitions>`;

/**
 * Two instances of this process wait for the same message name; only the one
 * whose `pedidoId` matches the delivered key may wake up.
 */
export const MESSAGE_CORRELATION = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs">
  <bpmn:message id="MsgPago" name="pedido-pago">
    <bpmn:extensionElements>
      <zeebe:subscription correlationKey="=pedidoId" />
    </bpmn:extensionElements>
  </bpmn:message>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="AguardarPagamento">
      <bpmn:messageEventDefinition messageRef="MsgPago" />
    </bpmn:intermediateCatchEvent>
    <bpmn:task id="Expedir" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="AguardarPagamento" />
    <bpmn:sequenceFlow id="f1" sourceRef="AguardarPagamento" targetRef="Expedir" />
    <bpmn:sequenceFlow id="f2" sourceRef="Expedir" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

/** Same message name, no correlation key declared: name is all there is. */
export const MESSAGE_NO_CORRELATION = MESSAGE_CORRELATION.replace(
  /<bpmn:extensionElements>[\s\S]*?<\/bpmn:extensionElements>/,
  '',
);

/** Correlation key on a receive task instead of a catch event. */
export const MESSAGE_CORRELATION_RECEIVE_TASK = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs">
  <bpmn:message id="MsgPago" name="pedido-pago">
    <bpmn:extensionElements>
      <zeebe:subscription correlationKey="=pedidoId" />
    </bpmn:extensionElements>
  </bpmn:message>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:receiveTask id="Receber" messageRef="MsgPago" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Receber" />
    <bpmn:sequenceFlow id="f1" sourceRef="Receber" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

/**
 * Two executable pools wired by message flows in both directions: the customer
 * sends an order, the shop confirms it. Neither pool can finish alone.
 */
export const COLLABORATION_TWO_POOLS = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs">
  <bpmn:collaboration id="Collab">
    <bpmn:participant id="PartCliente" name="Cliente" processRef="Cliente" />
    <bpmn:participant id="PartLoja" name="Loja" processRef="Loja" />
    <bpmn:messageFlow id="mfPedido" name="Pedido" sourceRef="EnviarPedido" targetRef="ReceberPedido" />
    <bpmn:messageFlow id="mfOk" name="Confirmacao" sourceRef="Confirmar" targetRef="ReceberOk" />
  </bpmn:collaboration>
  <bpmn:process id="Cliente" name="Cliente" isExecutable="true">
    <bpmn:startEvent id="C1" />
    <bpmn:sendTask id="EnviarPedido" name="Enviar pedido" />
    <bpmn:intermediateCatchEvent id="ReceberOk" name="Receber confirmacao">
      <bpmn:messageEventDefinition />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="C2" />
    <bpmn:sequenceFlow id="c1" sourceRef="C1" targetRef="EnviarPedido" />
    <bpmn:sequenceFlow id="c2" sourceRef="EnviarPedido" targetRef="ReceberOk" />
    <bpmn:sequenceFlow id="c3" sourceRef="ReceberOk" targetRef="C2" />
  </bpmn:process>
  <bpmn:process id="Loja" name="Loja" isExecutable="true">
    <bpmn:startEvent id="L1" />
    <bpmn:receiveTask id="ReceberPedido" name="Receber pedido" />
    <bpmn:userTask id="Separar" name="Separar itens" />
    <bpmn:sendTask id="Confirmar" name="Confirmar" />
    <bpmn:endEvent id="L2" />
    <bpmn:sequenceFlow id="l1" sourceRef="L1" targetRef="ReceberPedido" />
    <bpmn:sequenceFlow id="l2" sourceRef="ReceberPedido" targetRef="Separar" />
    <bpmn:sequenceFlow id="l3" sourceRef="Separar" targetRef="Confirmar" />
    <bpmn:sequenceFlow id="l4" sourceRef="Confirmar" targetRef="L2" />
  </bpmn:process>
</bpmn:definitions>`;
