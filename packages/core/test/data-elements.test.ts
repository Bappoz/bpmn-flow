import { describe, expect, it } from 'vitest';
import { parseBpmn } from '../src/index.js';

const DATA = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="t">
  <bpmn:dataStore id="Clientes" name="Base de clientes" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:dataObject id="pedido" name="Pedido" />
    <bpmn:dataObject id="itens" name="Itens" isCollection="true" />
    <bpmn:dataObjectReference id="refPedido" name="Pedido" dataObjectRef="pedido" />
    <bpmn:dataStoreReference id="refClientes" name="Clientes" dataStoreRef="Clientes" />
    <bpmn:startEvent id="Start" />
    <bpmn:subProcess id="Sub">
      <bpmn:dataObject id="rascunho" name="Rascunho" />
      <bpmn:startEvent id="SubStart" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="s1" sourceRef="SubStart" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Sub" />
    <bpmn:sequenceFlow id="f1" sourceRef="Sub" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

describe('data elements', () => {
  it('models the data a process declares', async () => {
    const model = await parseBpmn(DATA);
    const process = model.processes[0]!;
    expect(process.dataElements?.map((d) => d.id)).toEqual([
      'pedido',
      'itens',
      'refPedido',
      'refClientes',
    ]);
    expect(process.dataElements?.find((d) => d.id === 'pedido')).toMatchObject({
      kind: 'dataObject',
      name: 'Pedido',
    });
    expect(process.dataElements?.find((d) => d.id === 'itens')?.isCollection).toBe(true);
  });

  it('keeps a reference pointing at what it references', async () => {
    const model = await parseBpmn(DATA);
    const data = model.processes[0]!.dataElements ?? [];
    expect(data.find((d) => d.id === 'refPedido')).toMatchObject({
      kind: 'dataObjectReference',
      dataRef: 'pedido',
    });
    expect(data.find((d) => d.id === 'refClientes')).toMatchObject({
      kind: 'dataStoreReference',
      dataRef: 'Clientes',
    });
  });

  it('reads definitions-level data stores', async () => {
    const model = await parseBpmn(DATA);
    expect(model.dataStores).toEqual([
      { id: 'Clientes', kind: 'dataStore', name: 'Base de clientes' },
    ]);
  });

  it('reads the data a subprocess scope declares', async () => {
    const model = await parseBpmn(DATA);
    const sub = model.processes[0]!.flowNodes.find((n) => n.id === 'Sub')!;
    expect(sub.process?.dataElements?.map((d) => d.id)).toEqual(['rascunho']);
  });

  it('leaves data-free diagrams without the field', async () => {
    const model = await parseBpmn(`<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="t">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`);
    expect(model.processes[0]!.dataElements).toBeUndefined();
    expect(model.dataStores).toEqual([]);
  });
});
