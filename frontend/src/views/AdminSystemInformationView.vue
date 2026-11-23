<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ParentLink from '../components/ParentLink.vue';
import { api } from '../api/client';

type SystemInformation = {
  system: {
    hostname: string;
    os: string;
    cpuArchitecture: string;
    availableCpuThreads: number;
    memoryUsedBytes: number;
    memoryLimitBytes: number | null;
    serverTime: string;
    uptimeSeconds: number;
  };
  docker: {
    running: number;
    cpus: number;
    memoryMb: number;
    pids: number;
    wallTimeMs: number;
  } | null;
};

const information = ref<SystemInformation>();
const loading = ref(false);
const failed = ref(false);
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function mib(bytes: number) {
  return `${number.format(bytes / 1024 ** 2)} MiB`;
}

function duration(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [
    days && `${days}d`,
    hours && `${hours}h`,
    minutes && `${minutes}m`,
    `${seconds % 60}s`,
  ]
    .filter(Boolean)
    .join(' ');
}

const systemRows = computed(() => {
  const system = information.value?.system;
  if (!system) return [];
  const memoryLimit = system.memoryLimitBytes;
  return [
    ['Hostname', system.hostname],
    ['OS', system.os],
    [
      'CPU',
      `${system.cpuArchitecture}, ${number.format(system.availableCpuThreads)} available threads`,
    ],
    [
      'Memory',
      `${mib(system.memoryUsedBytes)} API resident memory${memoryLimit === null ? '' : ` / ${mib(memoryLimit)} container limit`}`,
    ],
    [
      'Server time',
      system.serverTime.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'),
    ],
    ['Uptime', duration(system.uptimeSeconds)],
  ];
});

const dockerRows = computed(() => {
  const docker = information.value?.docker;
  if (!docker) return [];
  return [
    ['Running compiler containers', number.format(docker.running)],
    ['CPU limit', `${number.format(docker.cpus)} CPUs`],
    ['Memory limit', `${number.format(docker.memoryMb)} MiB`],
    ['PID limit', number.format(docker.pids)],
    ['Wall-time limit', `${number.format(docker.wallTimeMs / 1000)} s`],
  ];
});

async function load() {
  loading.value = true;
  failed.value = false;
  try {
    information.value = await api<SystemInformation>(
      '/api/admin/system-information',
    );
  } catch {
    information.value = undefined;
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <ParentLink to="/admin" label="Admin" />
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1>System Information</h1>
    <button
      class="btn btn-outline"
      type="button"
      :disabled="loading"
      @click="load"
    >
      Refresh
    </button>
  </div>
  <p v-if="loading && !information" class="mt-5" role="status">
    Loading system information…
  </p>
  <p v-if="failed" class="mt-5" role="alert">
    Could not load system information.
  </p>
  <template v-if="information">
    <section
      v-for="section in [
        {
          id: 'system',
          title: 'API System Information',
          rows: systemRows,
        },
        {
          id: 'docker',
          title: 'Docker',
          rows: dockerRows,
        },
      ]"
      :key="section.id"
      class="grid gap-4 border-b border-outline py-7"
      :aria-labelledby="section.id + '-heading'"
    >
      <div>
        <h2 :id="section.id + '-heading'">{{ section.title }}</h2>
      </div>
      <dl v-if="section.rows.length" class="grid gap-3">
        <div
          v-for="[label, value] in section.rows"
          :key="label"
          class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4"
        >
          <dt class="font-semibold">{{ label }}</dt>
          <dd class="break-words tabular-nums">{{ value }}</dd>
        </div>
      </dl>
      <p v-else role="status">Worker Docker information unavailable.</p>
    </section>
  </template>
</template>
