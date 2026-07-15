<script lang="ts">
  import VitalsForm from '../components/log/VitalsForm.svelte'
  import SymptomForm from '../components/log/SymptomForm.svelte'
  import MedForm from '../components/log/MedForm.svelte'
  import FoodForm from '../components/log/FoodForm.svelte'
  import ExerciseForm from '../components/log/ExerciseForm.svelte'
  import NoteForm from '../components/log/NoteForm.svelte'
  import MindfulnessForm from '../components/log/MindfulnessForm.svelte'
  import PaperRecordForm from '../components/log/PaperRecordForm.svelte'

  let { kind }: { kind: string } = $props()
</script>

{#if kind === 'vitals'}
  <VitalsForm />
{:else if kind === 'symptom'}
  <SymptomForm />
{:else if kind === 'med'}
  <MedForm />
{:else if kind === 'food'}
  <FoodForm />
{:else if kind === 'exercise'}
  <ExerciseForm />
{:else if kind === 'note'}
  <NoteForm />
{:else if kind === 'mind'}
  <MindfulnessForm />
{:else if kind === 'paper'}
  <PaperRecordForm />
{:else}
  <p class="muted" data-testid="log-unknown">Nothing to log under “{kind}”.</p>
{/if}
