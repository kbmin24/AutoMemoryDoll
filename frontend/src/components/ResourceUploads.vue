<script setup lang="ts">
defineProps<{ aliases: string[]; disabled?: boolean }>();
const files = defineModel<Record<string, File>>({ required: true });
function choose(alias: string, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) files.value[alias] = file;
  else delete files.value[alias];
}
</script>
<template>
  <section v-if="aliases.length" class="mt-7" aria-label="Required resources">
    <h2>Files for this document</h2>
    <p id="upload-help">
      Required files. Up to 20 MiB per file and 100 MiB total.
    </p>
    <div v-for="(alias, index) in aliases" :key="alias" class="mb-5">
      <label class="block" :for="`resource-${index}`">{{ alias }}</label>
      <input
        :id="`resource-${index}`"
        class="file-input w-full"
        type="file"
        required
        :disabled="disabled"
        aria-describedby="upload-help"
        @change="choose(alias, $event)"
      />
    </div>
  </section>
</template>
