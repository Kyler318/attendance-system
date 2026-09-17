<script setup>
import { computed } from 'vue';

const props = defineProps({
  modelValue: { type: Number, default: null },
  presets: { type: Array, default: () => [100, 80, 60, 40] },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const isCustom = computed(() => props.modelValue !== null && !props.presets.includes(props.modelValue));

function pick(v) {
  emit('update:modelValue', v);
}
function onCustomInput(e) {
  const v = e.target.value === '' ? null : Number(e.target.value);
  emit('update:modelValue', v);
}
</script>

<template>
  <div class="row" style="gap: 4px; flex-wrap: nowrap; justify-content: center">
    <button
      v-for="p in presets"
      :key="p"
      type="button"
      :disabled="disabled"
      :class="{ primary: modelValue === p }"
      style="padding: 4px 8px; font-size: 13px"
      @click="pick(p)"
    >
      {{ p }}
    </button>
    <input
      type="number"
      min="0"
      max="100"
      placeholder="自訂"
      :disabled="disabled"
      :value="isCustom ? modelValue : ''"
      @input="onCustomInput"
      style="width: 56px; padding: 4px 6px; font-size: 13px"
    />
  </div>
</template>
