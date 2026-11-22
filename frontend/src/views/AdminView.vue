<template>
  <h1>Admin</h1>
  <div
    class="mt-7 grid grid-cols-1 gap-6 workspace:grid-cols-2 cards:grid-cols-3"
  >
    <RouterLink
      to="/admin/users"
      class="card flex-row items-center gap-4 border border-outline bg-base-100 p-5 font-semibold hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <i class="fa-solid fa-users text-muted" aria-hidden="true"></i>
      Users
    </RouterLink>
    <RouterLink
      to="/admin/ai"
      class="card flex-row items-center gap-4 border border-outline bg-base-100 p-5 font-semibold hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <i
        class="fa-solid fa-wand-magic-sparkles text-muted"
        aria-hidden="true"
      ></i>
      AI
    </RouterLink>
  </div>
</template>
