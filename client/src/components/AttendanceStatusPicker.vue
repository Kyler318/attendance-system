<script setup>
const props = defineProps({
  modelValue: { type: String, default: null },
  options: { type: Array, required: true }, // [{status, label, score}]
});
const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <select :value="modelValue" @change="emit('update:modelValue', $event.target.value)" style="min-width: 190px">
    <option value="" disabled>請選擇出席狀態</option>
    <option v-for="opt in options" :key="opt.status" :value="opt.status">
      {{ opt.label }}({{ opt.score }}分)
    </option>
  </select>
</template>
