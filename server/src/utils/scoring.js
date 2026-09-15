// 出席分計分規則
// 單課 (single period)
const SINGLE_STATUS_SCORES = {
  on_time: 100, // 準時出席
  late: 90, // 遲到
  absent: 0, // 缺席
};

// 雙課 (double / consecutive two periods)
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

function statusOptions(periodMode) {
  const map = periodMode === 'double' ? DOUBLE_STATUS_LABELS : SINGLE_STATUS_LABELS;
  const scores = periodMode === 'double' ? DOUBLE_STATUS_SCORES : SINGLE_STATUS_SCORES;
  return Object.keys(map).map((status) => ({
    status,
    label: map[status],
    score: scores[status],
  }));
}

function scoreFor(periodMode, status) {
  const map = periodMode === 'double' ? DOUBLE_STATUS_SCORES : SINGLE_STATUS_SCORES;
  if (!(status in map)) {
    throw new Error(`無效嘅出席狀態: ${status} (period_mode=${periodMode})`);
  }
  return map[status];
}

const PRESET_SCORES = [100, 80, 60, 40];

module.exports = { statusOptions, scoreFor, PRESET_SCORES };
