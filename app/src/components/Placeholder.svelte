<script lang="ts">
  let { title, phase, what }: { title: string; phase: number; what: string } = $props();
</script>

<section class="card">
  <h1>{title}</h1>
  <p class="muted">Not built yet. Phase {phase} adds {what}</p>
</section>
