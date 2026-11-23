<script setup lang="ts">
import ParentLink from '../components/ParentLink.vue';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api/client';

type AppUsage = {
  usedTokens: string;
  quotaTokens: number;
  userQuotaTokens: number;
  resetsAt: string;
  enabled: boolean;
};

type QuotaLimits = { appMonthlyTokens: number; userMonthlyTokens: number };

const usage = ref<AppUsage>();
const loadError = ref(false);
const toggling = ref(false);
const toggleError = ref('');
const loading = ref(false);
const saving = ref(false);
const saved = ref(false);
const saveError = ref('');
const appLimit = ref('');
const userLimit = ref('');
const now = ref(Date.now());
let timer: number | undefined;

const pendingLimits = computed(() => {
  if (!usage.value) return null;
  const appMonthlyTokens = Number(appLimit.value);
  const userMonthlyTokens = Number(userLimit.value);
  if (
    !/^\d+$/.test(appLimit.value) ||
    !/^\d+$/.test(userLimit.value) ||
    !Number.isSafeInteger(appMonthlyTokens) ||
    !Number.isSafeInteger(userMonthlyTokens)
  )
    return null;

  return {
    ...(appMonthlyTokens !== usage.value.quotaTokens && { appMonthlyTokens }),
    ...(userMonthlyTokens !== usage.value.userQuotaTokens && {
      userMonthlyTokens,
    }),
  };
});

const resetTime = computed(() => {
  if (!usage.value) return '';
  const minutes = Math.ceil(
    (Date.parse(usage.value.resetsAt) - now.value) / 60_000,
  );
  if (minutes <= 0) return 'Resetting usage…';

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const parts = [
    days ? `${days} ${days === 1 ? 'day' : 'days'}` : '',
    hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '',
  ].filter(Boolean);
  return `Resets in ${parts.join(', ') || `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`} (UTC).`;
});
const percentage = computed(() => {
  if (!usage.value?.quotaTokens) return 0;
  const used = BigInt(usage.value.usedTokens);
  const quota = BigInt(usage.value.quotaTokens);
  return used >= quota ? 100 : Number((used * 10_000n) / quota) / 100;
});

async function loadUsage() {
  if (loading.value || saving.value || toggling.value) return;
  loading.value = true;
  try {
    const current = await api<AppUsage>('/api/admin/ai/usage');
    if (!usage.value || appLimit.value === String(usage.value.quotaTokens))
      appLimit.value = String(current.quotaTokens);
    if (!usage.value || userLimit.value === String(usage.value.userQuotaTokens))
      userLimit.value = String(current.userQuotaTokens);
    usage.value = current;
    now.value = Date.now();
    loadError.value = false;
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

async function changeAiEnabled(event: Event) {
  const input = event.target as HTMLInputElement;
  const current = usage.value;
  if (!current) return;
  const enabled = input.checked;
  input.checked = current.enabled;
  if (loading.value || toggling.value || enabled === current.enabled) return;

  toggling.value = true;
  toggleError.value = '';
  try {
    const result = await api<{ enabled: boolean }>(
      '/api/admin/ai/enabled',
      'PATCH',
      { enabled },
    );
    current.enabled = result.enabled;
  } catch (cause) {
    toggleError.value = (cause as Error).message;
  } finally {
    toggling.value = false;
  }
}

async function saveLimits() {
  const changes = pendingLimits.value;
  if (
    loading.value ||
    saving.value ||
    !usage.value ||
    !changes ||
    !Object.keys(changes).length
  )
    return;

  saving.value = true;
  saveError.value = '';
  saved.value = false;
  try {
    const limits = await api<QuotaLimits>(
      '/api/admin/ai/quotas',
      'PATCH',
      changes,
    );
    usage.value.quotaTokens = limits.appMonthlyTokens;
    usage.value.userQuotaTokens = limits.userMonthlyTokens;
    appLimit.value = String(limits.appMonthlyTokens);
    userLimit.value = String(limits.userMonthlyTokens);
    saved.value = true;
  } catch (cause) {
    saveError.value = (cause as Error).message;
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void loadUsage();
  timer = window.setInterval(() => {
    now.value = Date.now();
    if (usage.value && now.value >= Date.parse(usage.value.resetsAt))
      void loadUsage();
  }, 60_000);
});
onUnmounted(() => window.clearInterval(timer));
</script>

<template>
  <ParentLink to="/admin" label="Admin" />
  <h1>AI</h1>
  <section
    v-if="usage"
    class="grid min-w-0 grid-cols-1 gap-4 border-b border-outline py-7 workspace:grid-cols-[minmax(180px,1fr)_minmax(260px,480px)] workspace:gap-9"
    aria-labelledby="ai-availability-heading"
  >
    <div>
      <h2 id="ai-availability-heading">AI availability</h2>
      <p>Turn off AI features for everyone on the website.</p>
    </div>
    <div class="min-w-0 self-center">
      <label class="flex w-fit items-center gap-3 font-semibold">
        <input
          type="checkbox"
          role="switch"
          class="toggle toggle-primary"
          :checked="usage.enabled"
          :disabled="loading || toggling"
          @change="changeAiEnabled"
        />
        Enable AI features
      </label>
      <p v-if="toggleError" class="mt-2" role="alert">{{ toggleError }}</p>
    </div>
  </section>
  <section
    class="grid min-w-0 grid-cols-1 gap-4 border-b border-outline py-7 workspace:grid-cols-[minmax(180px,1fr)_minmax(260px,480px)] workspace:gap-9"
    aria-labelledby="app-ai-usage-heading"
  >
    <div>
      <h2 id="app-ai-usage-heading">Website-wide AI usage</h2>
      <p v-if="resetTime" class="text-sm text-muted">{{ resetTime }}</p>
    </div>
    <div class="min-w-0 self-center">
      <p v-if="loadError" role="alert">Could not load AI usage.</p>
      <template v-else-if="usage">
        <p class="mb-2 font-semibold tabular-nums">
          {{ BigInt(usage.usedTokens).toLocaleString() }} of
          {{ usage.quotaTokens.toLocaleString() }} tokens
        </p>
        <progress
          v-if="usage.quotaTokens > 0"
          class="progress progress-primary block w-full"
          :value="percentage"
          max="100"
          aria-label="Website-wide monthly AI usage"
        ></progress>
        <p v-else>The monthly AI quota is disabled.</p>
        <p class="mt-2 text-sm text-muted">
          Includes outstanding token reservations.
        </p>
      </template>
      <p v-else role="status">Loading AI usage…</p>
    </div>
  </section>
  <section
    v-if="usage"
    class="grid min-w-0 grid-cols-1 gap-4 border-b border-outline py-7 workspace:grid-cols-[minmax(180px,1fr)_minmax(260px,480px)] workspace:gap-9"
    aria-labelledby="ai-limits-heading"
  >
    <div>
      <h2 id="ai-limits-heading">AI usage limits</h2>
      <p>
        Monthly limits in tokens. Set a limit to 0 to disable usage at that
        level.
      </p>
    </div>
    <form
      class="flex min-w-0 flex-col gap-2"
      @submit.prevent="saveLimits"
      @input="saved = false"
    >
      <label for="app-ai-limit">Website-wide limit</label>
      <input
        id="app-ai-limit"
        v-model="appLimit"
        class="input mb-2 w-full"
        inputmode="numeric"
        pattern="[0-9]+"
        required
        :disabled="saving"
      />
      <label for="user-ai-limit">Per-user limit</label>
      <input
        id="user-ai-limit"
        v-model="userLimit"
        class="input w-full"
        inputmode="numeric"
        pattern="[0-9]+"
        required
        :disabled="saving"
      />
      <p v-if="!pendingLimits" class="text-sm">
        Enter a whole number from 0 to 9,007,199,254,740,991 for each limit.
      </p>
      <p v-else-if="saveError" role="alert">{{ saveError }}</p>
      <p v-else-if="saved" role="status">Limits saved.</p>
      <button
        type="submit"
        class="btn btn-primary mt-2 self-start"
        :disabled="
          loading ||
          saving ||
          !pendingLimits ||
          !Object.keys(pendingLimits).length
        "
      >
        {{ saving ? 'Saving…' : 'Save limits' }}
      </button>
    </form>
  </section>
</template>
