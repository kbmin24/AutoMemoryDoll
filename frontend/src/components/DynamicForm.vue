<script setup lang="ts">
import type { ShapeField } from '../api/types';
import ScalarInput from './ScalarInput.vue';
import ListInput from './ListInput.vue';
defineProps<{
  fields: ShapeField[];
  disabled?: boolean;
  showValidation?: boolean;
}>();
const values = defineModel<Record<string, string | string[]>>({
  required: true,
});
</script>
<template>
  <div class="grid gap-5">
    <template v-for="field in fields" :key="field.variable">
      <ListInput
        v-if="field.type === 'list'"
        :id="`field-${field.variable}`"
        :label="field.label"
        :item-type="field.itemType"
        :optional="field.optional"
        :disabled="disabled"
        :show-validation="showValidation"
        :model-value="(values[field.variable] ?? []) as string[]"
        @update:model-value="values[field.variable] = $event"
      />
      <div v-else>
        <label class="block" :for="`field-${field.variable}`">
          {{ field.label }}
          <span v-if="field.optional" class="font-normal text-muted"
            >(optional)</span
          >
          <span
            v-else-if="
              showValidation && !String(values[field.variable] ?? '').trim()
            "
            :id="`field-${field.variable}-required`"
            class="ml-2 font-normal text-error"
            >Required</span
          >
        </label>
        <ScalarInput
          :id="`field-${field.variable}`"
          :type="field.type"
          :model-value="(values[field.variable] ?? '') as string"
          :disabled="disabled"
          :show-validation="showValidation"
          :required="!field.optional"
          @update:model-value="values[field.variable] = $event"
        />
      </div>
    </template>
  </div>
</template>
