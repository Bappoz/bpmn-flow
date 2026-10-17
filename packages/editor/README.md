# @bpmn-flow/editor

Browser BPMN 2.0 authoring built on bpmn-js. The host application owns file
selection, persistence, and surrounding UI.

```ts
import { BpmnEditor } from '@bpmn-flow/editor';
import '@bpmn-flow/editor/styles.css';

const editor = new BpmnEditor(document.querySelector('#editor')!);
await editor.open(xml);
const result = await editor.validate();
const formattedXml = await editor.getXml();
const stopListening = editor.onChange(() => markDirty());
stopListening(); // call when the editor view is removed
```

`open()` computes diagram interchange when the input has none. It does not
modify the caller's source string; save only the XML returned by `getXml()`.
`newDiagram()` creates a valid process with a start event. Call `destroy()` when
the host removes the editor so bpmn-js can release its resources.
