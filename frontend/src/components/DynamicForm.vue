<script setup lang="ts">
import type { ShapeField } from '../api/types';
defineProps<{ fields: ShapeField[]; disabled?: boolean }>();
const values = defineModel<Record<string, string>>({ required: true });
</script>
<template>
  <div class="grid gap-5">
    <div v-for="field in fields" :key="field.variable">
      <label class="block" :for="`field-${field.variable}`"
        >{{ field.label }}
        <span v-if="field.optional" class="font-normal text-muted"
          >(optional)</span
        ></label
      >
      <textarea
        v-if="field.type === 'longtext'"
        :id="`field-${field.variable}`"
        v-model="values[field.variable]"
        class="textarea w-full"
        rows="5"
        :disabled="disabled"
        :required="!field.optional"
      />
      <select
        v-else-if="field.type === 'boolean'"
        :id="`field-${field.variable}`"
        v-model="values[field.variable]"
        class="select w-full"
        :disabled="disabled"
        :required="!field.optional"
      >
        <option value="">
          {{ field.optional ? 'Unset' : 'Choose a value' }}
        </option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
      <input
        v-else
        :id="`field-${field.variable}`"
        :value="values[field.variable]"
        @input="
          values[field.variable] = ($event.target as HTMLInputElement).value
        "
        :type="field.type === 'number' ? 'number' : 'text'"
        :step="field.type === 'number' ? 'any' : undefined"
        class="input w-full"
        :disabled="disabled"
        :required="!field.optional"
      />
    </div>
  </div>
</template>
