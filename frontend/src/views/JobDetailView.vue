<script setup lang="ts">
import { useRoute } from 'vue-router';
import JobResult from '../components/JobResult.vue';
const route = useRoute();
</script>
<template>
  <RouterLink class="link" to="/jobs">Job history</RouterLink>
  <h1 class="mt-5">Document generation</h1>
  <JobResult :job-id="String(route.params.id)" />
</template>
