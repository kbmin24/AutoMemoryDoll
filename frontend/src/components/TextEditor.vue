<script setup lang="ts">
import CodeEditArea from './CodeEditArea.vue';
import type { Completion } from '@codemirror/autocomplete';
import type { CodeLanguage } from '../editor';
const text = defineModel<string>({ required: true });
defineProps<{
  busy: boolean;
  dirty: boolean;
  lang?: CodeLanguage;
  variables?: readonly Completion[];
}>();
const emit = defineEmits<{ save: [] }>();
</script>
<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <CodeEditArea
      id="file-content"
      v-model="text"
      :lang="lang"
      :variables="variables"
      label="File content"
      :disabled="busy"
    />
    <div class="flex shrink-0 items-center gap-3">
      <button
        class="btn btn-primary shrink-0"
        :disabled="busy || !dirty"
        @click="emit('save')"
      >
        Save file
      </button>
      <p role="status" class="mb-0 min-w-0 flex-1 text-xs">
        {{ dirty ? 'Unsaved changes' : 'No unsaved file changes' }}
      </p>
    </div>
  </div>
</template>
