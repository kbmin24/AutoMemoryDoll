<script setup lang="ts">
import ParentLink from '../components/ParentLink.vue';
import { useRoute } from 'vue-router';
import JobResult from '../components/JobResult.vue';
const route = useRoute();
</script>
<template>
  <ParentLink to="/jobs" label="Job history" />
  <h1>Document generation</h1>
  <JobResult :job-id="String(route.params.id)" />
</template>
