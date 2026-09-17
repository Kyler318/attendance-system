// 出席分計分規則
// 單課 (single period) —— 遲到分數會因應班級類型(普中 general / 職中 vocational)唔同
const SINGLE_STATUS_SCORES = {
  general: { on_time: 100, late: 80, absent: 0 }, // 普中:遲到調整做 80
  vocational: { on_time: 100, late: 90, absent: 0 }, // 職中:維持 90
};

// 雙課 (double / consecutive two periods) —— 唔理班級類型,兩種都一樣
const DOUBLE_STATUS_SCORES = {
  on_time: 100, // 準時出席(兩節都準時)
  late_p1: 90, // 第一節遲到
  present_p2_on_time: 50, // 缺第一節,第二節準時到
  present_p2_late: 40, // 缺第一節,第二節遲到
  absent: 0, // 全缺
};

const SINGLE_STATUS_LABELS = {
  on_time: '準時出席',
  late: '遲到',
  absent: '缺席',
};

const DOUBLE_STATUS_LABELS = {
  on_time: '準時出席 (兩節)',
  late_p1: '第一節遲到',
  present_p2_on_time: '缺第一節,第二節準時',
  present_p2_late: '缺第一節,第二節遲到',
  absent: '缺席 (全缺)',
};

const CLASS_TYPES = ['general', 'vocational'];

function normalizeClassType(classType) {
  return CLASS_TYPES.includes(classType) ? classType : 'general';
}

function singleScoresFor(classType) {
  return SINGLE_STATUS_SCORES[normalizeClassType(classType)];
}

function statusOptions(periodMode, classType) {
  const map = periodMode === 'double' ? DOUBLE_STATUS_LABELS : SINGLE_STATUS_LABELS;
  const scores = periodMode === 'double' ? DOUBLE_STATUS_SCORES : singleScoresFor(classType);
  return Object.keys(map).map((status) => ({
    status,
    label: map[status],
    score: scores[status],
  }));
}

function scoreFor(periodMode, status, classType) {
  const map = periodMode === 'double' ? DOUBLE_STATUS_SCORES : singleScoresFor(classType);
  if (!(status in map)) {
    throw new Error(`無效嘅出席狀態: ${status} (period_mode=${periodMode})`);
  }
  return map[status];
}

const PRESET_SCORES = [100, 80, 60, 40];

module.exports = { statusOptions, scoreFor, PRESET_SCORES, CLASS_TYPES, normalizeClassType };
