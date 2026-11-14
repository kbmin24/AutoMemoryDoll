import { afterEach, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { syntaxTree } from '@codemirror/language';
import {
  CompletionContext,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { undo } from '@codemirror/commands';
import CodeEditArea from '../src/components/CodeEditArea.vue';
import { codeLanguageForFile } from '../src/editor';
import { editorView, setEditorText } from './helpers/code-editor';

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

it('highlights Jinja and LaTeX in the same document, then reconfigures without changing its text', async () => {
  const source =
    '\\section{Letter}\n{{ name | safe }}\n{% if active %}Hello{% endif %}';
  wrapper = mount(CodeEditArea, {
    attachTo: document.body,
    props: {
      modelValue: source,
      lang: 'jinja-latex',
      label: 'File content',
      id: 'file-content',
    },
  });
  await flushPromises();
  let tree = syntaxTree(editorView(wrapper).state);
  expect(tree.toString()).toContain('Interpolation');
  expect(tree.resolveInner(source.indexOf('section') + 1, 1).name).toContain(
    'CtrlSeq',
  );
  expect(wrapper.get('[contenteditable=true]').attributes('aria-label')).toBe(
    'File content',
  );
  await wrapper.setProps({ lang: 'latex' });
  tree = syntaxTree(editorView(wrapper).state);
  expect(tree.toString()).not.toContain('Interpolation');
  expect(editorView(wrapper).state.doc.toString()).toBe(source);
});
it('syncs editor changes to the model, accepts replacement text, and supports disabled editing', async () => {
  wrapper = mount(CodeEditArea, {
    attachTo: document.body,
    props: {
      modelValue: 'first',
      lang: 'javascript',
      label: 'Document data',
      describedBy: 'json-help',
    },
  });
  await flushPromises();
  await setEditorText(wrapper, '{"count":0,"flag":false}');
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([
    '{"count":0,"flag":false}',
  ]);
  expect(syntaxTree(editorView(wrapper).state).type.name).toBe('Script');
  await wrapper.setProps({ modelValue: '{"updated":true}', disabled: true });
  expect(editorView(wrapper).state.doc.toString()).toBe('{"updated":true}');
  expect(wrapper.get('.cm-content').attributes('contenteditable')).toBe(
    'false',
  );
  expect(wrapper.get('.cm-content').attributes('aria-describedby')).toBe(
    'json-help',
  );
});
it('keeps unspecified languages as plain text', async () => {
  wrapper = mount(CodeEditArea, { props: { modelValue: '{{ literal }}' } });
  await flushPromises();
  expect(syntaxTree(editorView(wrapper).state).length).toBe(0);
});
it.each([
  [['template.tex'], 'jinja-latex'],
  [['parts', 'template.tex'], 'latex'],
  [['Template.tex'], 'latex'],
  [['section.TEX'], 'latex'],
  [['article.cls'], 'latex'],
  [['layout.sty'], 'latex'],
  [['macros.ltx'], 'latex'],
  [['data.json'], 'javascript'],
  [['code.js'], 'javascript'],
  [['notes.txt'], undefined],
  [['README'], undefined],
] as const)('selects language for %j', (segments, expected) => {
  expect(codeLanguageForFile(segments)).toBe(expected);
});

async function suggestions() {
  const view = editorView(wrapper!);
  const position = view.state.doc.toString().indexOf('stu') + 3;
  const context = new CompletionContext(view.state, position, true);
  const sources = view.state.languageDataAt<CompletionSource>(
    'autocomplete',
    position,
  );
  const results = await Promise.all(sources.map((source) => source(context)));
  return results.flatMap((result) => result?.options ?? []);
}

it('suggests shape variables inside Jinja with label/type metadata and updates without resetting text/history', async () => {
  const initial = '{{ stu }}';
  wrapper = mount(CodeEditArea, {
    props: {
      modelValue: initial,
      lang: 'jinja-latex',
      variables: [
        {
          label: 'student_name',
          type: 'variable',
          detail: 'Student name · text',
        },
      ],
    },
  });
  await flushPromises();
  expect(await suggestions()).toContainEqual({
    label: 'student_name',
    type: 'variable',
    detail: 'Student name · text',
  });
  const view = editorView(wrapper);
  await setEditorText(wrapper, '{{ student }}');
  await wrapper.setProps({
    variables: [
      {
        label: 'student_number',
        type: 'variable',
        detail: 'Student number · number',
      },
    ],
  });
  expect(editorView(wrapper)).toBe(view);
  expect(view.state.doc.toString()).toBe('{{ student }}');
  const updated = await suggestions();
  expect(updated.some((option) => option.label === 'student_number')).toBe(
    true,
  );
  expect(updated.some((option) => option.label === 'student_name')).toBe(false);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(initial);
});

it.each(['latex', 'javascript'] as const)(
  'does not offer shape variables in %s mode',
  async (lang) => {
    wrapper = mount(CodeEditArea, {
      props: {
        modelValue: '{{ stu }}',
        lang,
        variables: [{ label: 'student_name', type: 'variable' }],
      },
    });
    await flushPromises();
    expect(
      (await suggestions()).some((option) => option.label === 'student_name'),
    ).toBe(false);
  },
);
