<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { logout, session } from './api/client';
import { watchSession } from './router';

const router = useRouter();
onUnmounted(watchSession(router));
const error = ref('');
const busy = ref(false);
const accountMenuOpen = ref(false);
const accountControls = ref<HTMLElement | null>(null);
const accountButton = ref<HTMLButtonElement | null>(null);

function dismissAccountMenu(event: MouseEvent) {
  if (!accountControls.value?.contains(event.target as Node)) {
    accountMenuOpen.value = false;
  }
}

function closeAccountMenu() {
  accountMenuOpen.value = false;
  accountButton.value?.focus();
}

function leaveAccountMenu(event: FocusEvent) {
  if (!accountControls.value?.contains(event.relatedTarget as Node | null)) {
    accountMenuOpen.value = false;
  }
}

onMounted(() => document.addEventListener('click', dismissAccountMenu));
onUnmounted(() => document.removeEventListener('click', dismissAccountMenu));
watch(
  () => router.currentRoute.value.fullPath,
  () => {
    accountMenuOpen.value = false;
  },
);

async function signOut() {
  accountMenuOpen.value = false;
  busy.value = true;
  error.value = '';
  try {
    await logout();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <a class="sr-only focus:not-sr-only focus:block focus:p-3" href="#main"
    >Skip to content</a
  >
  <header
    class="top-bar navbar min-h-[68px] flex-wrap gap-3 px-5 py-3.5 workspace:flex-nowrap workspace:gap-10 workspace:px-9 workspace:py-2.5"
  >
    <RouterLink to="/" class="brand flex min-h-11 shrink-0 items-center">
      <img
        src="/images/logo-large.svg"
        class="block h-8 w-auto max-w-[calc(100vw-40px)]"
        alt="AutoMemoryDoll"
      />
    </RouterLink>
    <nav
      class="order-3 flex basis-full shrink-0 gap-6 workspace:order-none workspace:basis-auto"
      v-if="session.user"
      aria-label="Main navigation"
    >
      <RouterLink
        class="flex min-h-11 items-center text-muted hover:text-base-content hover:underline hover:underline-offset-[10px]"
        to="/templates"
        >Templates</RouterLink
      >
      <RouterLink
        class="flex min-h-11 items-center text-muted hover:text-base-content hover:underline hover:underline-offset-[10px]"
        v-if="session.user.role !== 'user'"
        to="/admin/users"
        >Users</RouterLink
      >
    </nav>
    <div
      v-if="session.user"
      ref="accountControls"
      class="relative ml-auto flex min-w-0 items-center justify-end gap-2 workspace:gap-4"
      @keydown.esc.stop.prevent="closeAccountMenu"
      @focusout="leaveAccountMenu"
    >
      <button
        ref="accountButton"
        class="btn identity btn-square min-w-0 p-0 text-base-content btn-ghost"
        aria-label="Account menu"
        :aria-expanded="accountMenuOpen"
        aria-controls="account-menu"
        @click="accountMenuOpen = !accountMenuOpen"
      >
        <i class="fa-solid fa-circle-user text-xl" aria-hidden="true"></i>
      </button>
      <div
        v-if="accountMenuOpen"
        id="account-menu"
        class="dropdown-content absolute top-[calc(100%+8px)] right-0 z-10 w-[min(200px,calc(100vw-40px))] rounded-box border border-outline bg-base-100 p-1.5 shadow-lg"
      >
        <div class="account-username px-3 py-2.5 font-semibold wrap-anywhere">
          {{ session.user.username }}
        </div>
        <hr class="mx-1.5 my-1 border-0 border-t border-primary" />
        <RouterLink
          class="flex min-h-11 items-center rounded-field px-3 hover:bg-base-300"
          to="/account"
          >My Account</RouterLink
        >
        <button
          class="btn btn-ghost w-full justify-start px-3"
          :disabled="busy"
          @click="signOut"
        >
          Log out
        </button>
      </div>
    </div>
  </header>
  <div
    class="mx-auto max-w-[1600px] pb-0 workspace:px-3 workspace:pb-3"
    :class="{ guest: !session.user }"
  >
    <main
      class="min-h-[calc(100dvh-80px)] min-w-0 bg-base-100 px-5 py-6 workspace:rounded-xl workspace:border workspace:border-outline workspace:p-9"
      id="main"
      tabindex="-1"
    >
      <p v-if="error" role="alert">{{ error }}</p>
      <RouterView :key="$route.path" />
    </main>
  </div>
</template>
