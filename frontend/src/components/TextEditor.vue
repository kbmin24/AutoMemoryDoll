<script setup lang="ts">
import { ref } from 'vue';
const text = defineModel<string>({ required: true });
defineProps<{ busy: boolean; dirty: boolean }>();
const emit = defineEmits<{ save: [] }>();
const editor = ref<HTMLTextAreaElement | null>(null);
const alias = ref('');
const error = ref('');
function insert() {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(alias.value)) {
    error.value =
      'Invalid resource alias. Start with a letter; use letters, numbers, underscores or hyphens.';
    return;
  }
  error.value = '';
  const start = editor.value?.selectionStart ?? text.value.length;
  const end = editor.value?.selectionEnd ?? start;
  text.value =
    text.value.slice(0, start) +
    `@resource(${alias.value})` +
    text.value.slice(end);
  editor.value?.focus();
}
</script>
<template>
  <div class="mt-5">
    <label for="file-content">File content</label>
    <textarea
      class="textarea block min-h-[420px] w-full resize-y p-4 font-mono leading-relaxed [tab-size:2]"
      id="file-content"
      ref="editor"
      v-model="text"
      aria-label="File content"
      spellcheck="false"
      :disabled="busy"
    />
    <p role="status">
      {{ dirty ? 'Unsaved changes' : 'No unsaved file changes' }}
    </p>
    <div class="actions flex flex-wrap items-start gap-2">
      <button
        class="btn btn-primary"
        :disabled="busy || !dirty"
        @click="emit('save')"
      >
        Save file
      </button>
      <label
        >Resource alias<input
          class="input max-w-[220px] mb-5 min-h-[46px] w-full min-w-0"
          v-model="alias"
          aria-label="Resource alias"
          :disabled="busy"
      /></label>
      <button class="btn" :disabled="busy" @click="insert">
        Insert resource
      </button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
