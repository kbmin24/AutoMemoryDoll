<script setup lang="ts">
import { computed } from 'vue';
import { Codemirror } from 'vue-codemirror';
import { basicSetup, EditorView } from 'codemirror';
import type { Completion } from '@codemirror/autocomplete';
import { codeLanguageSupport, type CodeLanguage } from '../editor';

const text = defineModel<string>({ required: true });
const props = withDefaults(
  defineProps<{
    lang?: CodeLanguage;
    variables?: readonly Completion[];
    disabled?: boolean;
    id?: string;
    label?: string;
    describedBy?: string;
  }>(),
  { disabled: false, label: 'Code editor', variables: () => [] },
);

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    backgroundColor: '#fff',
    color: 'var(--color-base-content)',
  },
  '&.cm-focused': {
    outline: '2px solid var(--color-primary)',
    outlineOffset: '-2px',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    lineHeight: '1.7',
  },
  '.cm-content': { padding: '12px 0' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-base-200)',
    color: 'var(--color-muted)',
    borderRight: '1px solid var(--color-outline)',
  },
});
const extensions = computed(() => [
  basicSetup,
  ...(props.lang ? [codeLanguageSupport(props.lang, props.variables)] : []),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({
    'aria-label': props.label,
    spellcheck: 'false',
    ...(props.id ? { id: props.id } : {}),
    ...(props.describedBy ? { 'aria-describedby': props.describedBy } : {}),
  }),
  theme,
]);
</script>

<template>
  <div
    class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-field border border-[#b6b8af] bg-white"
  >
    <Codemirror
      v-model="text"
      :extensions="extensions"
      :disabled="disabled"
      :indent-with-tab="false"
      :tab-size="2"
      :style="{ height: '100%' }"
    />
  </div>
</template>
