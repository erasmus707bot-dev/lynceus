<script lang="ts">
  // "Reviewed" checkbox plus an optional one-line note for one function (brief §6.8).
  import { setReview } from '../lib/session.svelte';
  import { review } from '../lib/review.svelte';
  let { id, name }: { id: string; name: string } = $props();
  const r = $derived(review.reviews[id] ?? { done: false, note: '' });
  let editing = $state(false);
</script>

<div class="rv">
  <label class="chk"><input type="checkbox" checked={r.done} onchange={(e) => setReview(id, { done: e.currentTarget.checked })} data-testid="reviewed" aria-label={`Mark ${name}() reviewed`}> Reviewed</label>
  {#if editing || r.note}
    <input class="note" type="text" maxlength="200" placeholder="One-line note (optional)" value={r.note} aria-label={`Note for ${name}()`}
      onchange={(e) => setReview(id, { note: e.currentTarget.value })} onblur={() => (editing = false)} data-testid="review-note">
  {:else}
    <button class="btn sm" onclick={() => (editing = true)}>Add note</button>
  {/if}
</div>

<style>
  .rv { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-top: 6px; }
  .chk { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; }
  .chk input { width: 22px; height: 22px; accent-color: var(--ok); }
  .note { flex: 1 1 14em; min-width: 0; min-height: 40px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); padding: 4px 10px; font: inherit; }
  .btn.sm { min-height: 40px; padding: 2px 10px; font-size: 0.9rem; }
</style>
