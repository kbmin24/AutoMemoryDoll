<script setup lang="ts">
const text = defineModel<string>({ required: true });
defineProps<{ busy: boolean; dirty: boolean }>();
const emit = defineEmits<{ save: [] }>();
</script>
<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <label for="file-content" class="sr-only">File content</label>
    <textarea
      class="textarea block min-h-0 w-full flex-1 resize-none overflow-auto p-4 font-mono leading-relaxed [tab-size:2]"
      id="file-content"
      v-model="text"
      aria-label="File content"
      spellcheck="false"
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
