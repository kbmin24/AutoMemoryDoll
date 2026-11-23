<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { Dataset } from '../api/types';

const datasets = ref<Dataset[]>([]);
const loading = ref(true);
const error = ref('');
const modifiedFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    datasets.value = (
      await api<{ datasets: Dataset[] }>('/api/datasets')
    ).datasets;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1>Datasets</h1>
    <RouterLink class="btn btn-primary" to="/datasets/new"
      >New dataset</RouterLink
    >
  </div>
  <p v-if="loading" role="status">Loading datasets…</p>
  <p v-else-if="error" role="alert">
    {{ error }}
    <button type="button" class="btn btn-sm" @click="load">Retry</button>
  </p>
  <p
    v-else-if="!datasets.length"
    class="mt-5 border-y border-outline py-5 text-muted"
  >
    No datasets yet. Create a dataset to add rows or import a CSV file.
  </p>
  <div v-else class="mt-5 overflow-x-auto rounded-box border border-outline">
    <table class="table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col" class="text-right">Columns</th>
          <th scope="col" aria-sort="descending">Last modified</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="dataset in datasets" :key="dataset.id">
          <th scope="row" class="[overflow-wrap:anywhere]">
            <RouterLink
              :to="`/datasets/${dataset.id}`"
              class="font-semibold hover:underline hover:underline-offset-4"
              >{{ dataset.name }}</RouterLink
            >
          </th>
          <td class="text-right tabular-nums">{{ dataset.columns.length }}</td>
          <td>
            <time :datetime="dataset.updatedAt" class="text-muted">
              {{ modifiedFormat.format(new Date(dataset.updatedAt)) }}
            </time>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
