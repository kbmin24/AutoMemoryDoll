<script setup lang="ts">
import CodeEditArea from './CodeEditArea.vue';
defineProps<{ disabled?: boolean }>();
const value = defineModel<string>({ required: true });
</script>
<template>
  <div class="mb-2 block text-sm font-semibold">Document data</div>
  <p id="json-help">Enter a JSON object containing your template values.</p>
  <div class="flex h-72 min-h-72">
    <CodeEditArea
      id="generation-json"
      v-model="value"
      lang="javascript"
      label="Document data"
      :disabled="disabled"
      described-by="json-help"
    />
  </div>
</template>
