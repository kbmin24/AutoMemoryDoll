import { EditorView } from 'codemirror';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

export function editorView(
  wrapper: VueWrapper,
  selector = '.cm-editor',
): EditorView {
  const view = EditorView.findFromDOM(
    wrapper.get(selector).element as HTMLElement,
  );
  if (!view) throw new Error('CodeMirror editor was not mounted');
  return view;
}

export async function setEditorText(
  wrapper: VueWrapper,
  text: string,
  selector = '.cm-editor',
) {
  const view = editorView(wrapper, selector);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
  await flushPromises();
}
