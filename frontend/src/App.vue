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
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="top-bar">
    <RouterLink to="/" class="brand">
      <img src="/images/logo-large.svg" alt="AutoMemoryDoll" />
    </RouterLink>
    <nav v-if="session.user" aria-label="Main navigation">
      <RouterLink to="/templates">Templates</RouterLink>
      <RouterLink v-if="session.user.role !== 'user'" to="/admin/users"
        >Users</RouterLink
      >
    </nav>
    <div
      v-if="session.user"
      ref="accountControls"
      class="session-controls"
      @keydown.esc.stop.prevent="closeAccountMenu"
      @focusout="leaveAccountMenu"
    >
      <button
        ref="accountButton"
        class="identity text-button"
        aria-label="Account menu"
        :aria-expanded="accountMenuOpen"
        aria-controls="account-menu"
        @click="accountMenuOpen = !accountMenuOpen"
      >
        <i class="fa-regular fa-user" aria-hidden="true"></i>
      </button>
      <div v-if="accountMenuOpen" id="account-menu" class="account-popup">
        <div class="account-username">{{ session.user.username }}</div>
        <hr class="account-divider" />
        <RouterLink to="/account">My Account</RouterLink>
        <button class="text-button" :disabled="busy" @click="signOut">
          Log out
        </button>
      </div>
    </div>
  </header>
  <div class="shell" :class="{ guest: !session.user }">
    <main id="main" tabindex="-1">
      <p v-if="error" role="alert">{{ error }}</p>
      <RouterView :key="$route.path" />
    </main>
  </div>
</template>

<style scoped>
.text-button {
  background: transparent;
  border-color: transparent;
}

.top-bar nav {
  display: flex;
  gap: 24px;
  flex-shrink: 0;
}

.top-bar nav a {
  display: flex;
  align-items: center;
  min-height: 44px;
  text-decoration: none;
  color: var(--muted);
}

.top-bar nav a:hover,
.top-bar nav a.router-link-active {
  color: #30312f;
  text-decoration: underline;
  text-underline-offset: 10px;
}

.top-bar {
  min-height: 68px;
  padding: 10px 36px;
  display: flex;
  align-items: center;
  gap: 40px;
}

.brand {
  display: flex;
  align-items: center;
  min-height: 44px;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.6px;
  flex-shrink: 0;
}

.brand img {
  display: block;
  height: 32px;
  width: auto;
}

.identity {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  color: inherit;
  overflow-wrap: anywhere;
  min-width: 0;
  font-size: inherit;
}

.fa-regular.fa-user {
  display: block;
  width: 18px;
  height: 20px;
  background-color: currentColor;
  mask: url('/images/user-regular.svg') center / contain no-repeat;
}

.account-popup {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 10;
  width: min(200px, calc(100vw - 40px));
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 4px 16px rgb(48 49 47 / 10%);
}

.account-popup a,
.account-popup button {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  text-align: left;
  text-decoration: none;
  border: 1px solid transparent;
  border-radius: 4px;
}

.account-popup a:hover {
  background: #e9e7e1;
}

.account-username {
  padding: 10px 12px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.account-divider {
  margin: 4px 6px;
  border: 0;
  border-top: 1px solid var(--accent);
}

@media (max-width: 1000px) {
  .template-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}


@media (max-width: 720px) {
    .top-bar {
    padding: 14px 20px;
    flex-wrap: wrap;
    gap: 12px;
  }

  .brand {
    font-size: 18px;
  }

  .session-controls {
    gap: 8px;
    flex-wrap: wrap;
  }

  .top-bar nav {
    order: 3;
    flex-basis: 100%;
    gap: 24px;
  }
}

</style>