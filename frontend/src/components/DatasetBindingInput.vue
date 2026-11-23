<script setup lang="ts">
import { computed } from 'vue';
import type { Dataset, DatasetBinding, ShapeField } from '../api/types';

const props = defineProps<{
  field: Extract<ShapeField, { type: 'object-list' }>;
  datasets: Dataset[];
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{ load: [] }>();
const binding = defineModel<DatasetBinding>();
const compatible = computed(() =>
  props.datasets.filter((dataset) => {
    const types = new Set(dataset.columns.map((column) => column.type));
    return (
      props.field.properties.every(
        (property) => property.optional || types.has(property.type),
      ) && props.field.properties.some((property) => types.has(property.type))
    );
  }),
);
const selection = computed(() =>
  compatible.value.find((dataset) => dataset.id === binding.value?.datasetId),
);

function changeSource(event: Event) {
  const source = (event.target as HTMLSelectElement).value;
  binding.value =
    source === 'dataset'
      ? {
          field: props.field.variable,
          datasetId: '',
          mode: 'first',
          count: 1,
          columns: {},
        }
      : undefined;
  if (source === 'dataset') emit('load');
}

function changeDataset(event: Event) {
  if (!binding.value) return;
  binding.value = {
    ...binding.value,
    datasetId: (event.target as HTMLSelectElement).value,
    columns: {},
  };
}

function changeColumn(property: string, event: Event) {
  if (!binding.value) return;
  const column = (event.target as HTMLSelectElement).value;
  const columns = { ...binding.value.columns, [property]: column };
  if (!column) delete columns[property];
  binding.value = { ...binding.value, columns };
}

function columnValue(property: string) {
  const columns = binding.value?.columns;
  return columns && Object.hasOwn(columns, property) ? columns[property] : '';
}
</script>

<template>
  <div class="mb-4 grid gap-3">
    <label class="grid gap-1" :for="`source-${field.variable}`">
      Source
      <select
        :id="`source-${field.variable}`"
        class="select w-full"
        :value="binding ? 'dataset' : 'manual'"
        @change="changeSource"
      >
        <option value="manual">Manual entry</option>
        <option value="dataset">Dataset</option>
      </select>
    </label>

    <template v-if="binding">
      <p v-if="loading" role="status">Loading datasets…</p>
      <p v-else-if="error" role="alert">
        {{ error }}
        <button type="button" class="btn btn-sm" @click="emit('load')">
          Retry
        </button>
      </p>
      <p v-else-if="!compatible.length" class="text-sm text-muted">
        No datasets match these property types.
        <RouterLink to="/datasets" class="underline underline-offset-4"
          >Manage datasets</RouterLink
        >
      </p>
      <template v-else>
        <label class="grid gap-1" :for="`dataset-${field.variable}`">
          Dataset
          <select
            :id="`dataset-${field.variable}`"
            class="select w-full"
            :value="binding.datasetId"
            @change="changeDataset"
          >
            <option value="">Choose a dataset</option>
            <option
              v-for="dataset in compatible"
              :key="dataset.id"
              :value="dataset.id"
            >
              {{ dataset.name }}
            </option>
          </select>
        </label>
        <template v-if="selection">
          <div
            class="grid gap-3"
            :class="{ 'grid-cols-2': binding.mode !== 'all' }"
          >
            <label class="grid min-w-0 gap-1" :for="`mode-${field.variable}`">
              Selection
              <select
                :id="`mode-${field.variable}`"
                v-model="binding.mode"
                class="select w-full"
              >
                <option value="first">First rows</option>
                <option value="last">Last rows</option>
                <option value="random">Random rows</option>
                <option value="all">All rows</option>
              </select>
            </label>
            <label
              v-if="binding.mode !== 'all'"
              class="grid min-w-0 gap-1"
              :for="`count-${field.variable}`"
            >
              Row count
              <input
                :id="`count-${field.variable}`"
                v-model.number="binding.count"
                type="number"
                min="1"
                max="1000"
                step="1"
                class="input w-full"
              />
            </label>
          </div>
          <fieldset class="grid gap-2 rounded-box border border-outline p-3">
            <legend class="px-1 text-sm font-semibold">Column mapping</legend>
            <label
              v-for="property in field.properties"
              :key="property.variable"
              class="grid gap-1"
              :for="`mapping-${field.variable}-${property.variable}`"
            >
              {{ property.label
              }}<span v-if="property.optional" class="text-sm text-muted"
                >(optional)</span
              >
              <select
                :id="`mapping-${field.variable}-${property.variable}`"
                class="select w-full"
                :value="columnValue(property.variable)"
                @change="changeColumn(property.variable, $event)"
              >
                <option value="">
                  {{ property.optional ? 'Leave unmapped' : 'Choose a column' }}
                </option>
                <option
                  v-for="column in selection.columns.filter(
                    (column) => column.type === property.type,
                  )"
                  :key="column.id"
                  :value="column.id"
                >
                  {{ column.label }}
                </option>
              </select>
            </label>
          </fieldset>
        </template>
      </template>
    </template>
  </div>
</template>
