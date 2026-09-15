const path = require('path');
const ExcelJS = require('exceljs');

// 學校提供嘅正式範本檔案(「26-27上普中各班分紙(交分使用).xlsx」),匯出時直接讀取呢個檔案嚟填資料,
// 唔再用程式碼重畫版面 —— 保證匯出出嚟嘅格式、字型、公式、邊框同範本一模一樣。
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'class-export-template.xlsx');

// 範本入面固定嘅欄位置(對應「出席分」C~R、「表現分」T~AP、「堂課分」AR~BH、平均分、測驗欄)
const TEMPLATE_LAYOUT = {
  headerRows: 4,
  templateStudentRows: 30, // 範本原本有 30 行學生 (第 5~34 行)
  attendanceStart: 3, // C
  attendanceAvgCol: 19, // S
  performanceStart: 20, // T (亦都係「科目」數值格嘅位置)
  performanceAvgCol: 43, // AQ
  lessonStart: 44, // AR
  lessonAvgCol: 61, // BI
  testCol: 62, // BJ (亦都係「導師」標籤所在嘅最後一欄)
};

// ---------- 匯入花名冊 ----------
// 格式(同用戶提供嘅圖片一致):第 5 行開始,A 欄 = 學號,B 欄 = 姓名,讀到姓名空白為止
function parseRosterSheet(sheet) {
  const students = [];
  const startRow = 5;
  let row = startRow;
  let blankStreak = 0;
  while (blankStreak < 5 && row < startRow + 500) {
    const nameCell = sheet.getCell(`B${row}`);
    const seatCell = sheet.getCell(`A${row}`);
    const name = (nameCell.value ?? '').toString().trim();
    if (!name) {
      blankStreak += 1;
      row += 1;
      continue;
    }
    blankStreak = 0;
    const seatRaw = seatCell.value;
    const seatNo = Number(seatRaw) || students.length + 1;
    students.push({ seatNo, name });
    row += 1;
  }
  return students;
}

async function parseRosterBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Excel 檔案入面搵唔到工作表');
  const students = parseRosterSheet(sheet);
  if (students.length === 0) throw new Error('喺 B 欄(第 5 行開始)搵唔到任何學生姓名');
  return students;
}

// 批量匯入:一個 Excel 入面可以有多個工作表,每個工作表名就係對應嘅班級名
// (同匯出範本嘅分頁命名方式一致,例如工作表名 "2A" 就會匯入去班級名叫 "2A" 嗰班)
async function parseRosterWorkbookSheets(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (workbook.worksheets.length === 0) throw new Error('Excel 檔案入面搵唔到任何工作表');
  return workbook.worksheets.map((sheet) => ({
    className: (sheet.name || '').trim(),
    students: parseRosterSheet(sheet),
  }));
}

// ---------- 匯出點名/評分表 ----------
// 版面對齊學校原本嘅範本:「26-27上普中各班分紙(交分使用).xlsx」
// attendanceDates / performanceDates / lessonDates: 各自獨立、已排序嘅日期字串陣列 (YYYY-MM-DD)
//   (出席、表現、堂課三組唔一定同一組日期,所以分開計,對應範本入面三組唔同闊度嘅日期欄)
function sanitizeSheetName(name) {
  const cleaned = String(name || '').replace(/[\\/*?:[\]]/g, '_').trim().slice(0, 31);
  return cleaned || '工作表';
}

async function buildClassExportWorkbook({
  className,
  subjectName,
  homeroomTeacher,
  students,
  attendanceDates,
  performanceDates,
  lessonDates,
  attendanceMap,
  performanceMap,
  lessonScoreMap,
  tests,
}) {
  attendanceDates = attendanceDates || [];
  performanceDates = performanceDates || [];
  lessonDates = lessonDates || [];

  const {
    headerRows,
    templateStudentRows,
    attendanceStart,
    attendanceAvgCol,
    performanceStart,
    performanceAvgCol,
    lessonStart,
    lessonAvgCol,
    testCol,
  } = TEMPLATE_LAYOUT;

  // 範本嘅日期欄數量係固定嘅(出席16欄/表現23欄/堂課17欄),如果實際記錄嘅日期多過範本容量,
  // 冇位擺,寧願報錯提醒管理員,都好過靜靜雞截斷資料或者整壞份範本嘅版面。
  const capacityOf = (avgCol, startCol) => avgCol - startCol;
  const overflow = [];
  if (attendanceDates.length > capacityOf(attendanceAvgCol, attendanceStart)) {
    overflow.push(`出席分(${attendanceDates.length}/${capacityOf(attendanceAvgCol, attendanceStart)} 格)`);
  }
  if (performanceDates.length > capacityOf(performanceAvgCol, performanceStart)) {
    overflow.push(`表現分(${performanceDates.length}/${capacityOf(performanceAvgCol, performanceStart)} 格)`);
  }
  if (lessonDates.length > capacityOf(lessonAvgCol, lessonStart)) {
    overflow.push(`堂課分(${lessonDates.length}/${capacityOf(lessonAvgCol, lessonStart)} 格)`);
  }
  if (overflow.length > 0) {
    throw new Error(`記錄日期數量超過範本欄位上限,請聯絡管理員擴充範本:${overflow.join('、')}`);
  }

  // 每次都由乾淨嘅範本檔案讀入,咁先至保證版面、字型、公式、邊框、凍結窗格等完全同原檔一樣
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_PATH);
  const sheet = workbook.worksheets[0];
  sheet.name = sanitizeSheetName(className);

  // Row 2: 班級 / 科目 / 導師 (「科目:」「導師:」呢兩個標籤範本已經有,只填返數值)
  sheet.getCell(2, 1).value = `班級:${className}`;
  sheet.getCell(2, performanceStart).value = subjectName || '';
  sheet.getCell(2, testCol).value = `導師:${homeroomTeacher || ''}`;

  // Row 4: 日期欄 (未用到嘅欄喺範本入面本身就係空,唔使特登清)
  const writeDates = (startCol, dateList) => {
    dateList.forEach((d, i) => {
      sheet.getCell(4, startCol + i).value = d;
    });
  };
  writeDates(attendanceStart, attendanceDates);
  writeDates(performanceStart, performanceDates);
  writeDates(lessonStart, lessonDates);

  // 學生列數同範本原有嘅 30 行唔一定啱好對得上,要調整
  if (students.length > templateStudentRows) {
    // 範本每 5 行有一條較粗嘅分組線(第 5/10/15... 行底部),逐行複製對應嗰個位置嘅樣式,
    // 等超過 30 人嘅班都可以維持返呢個分組樣式,唔會成排都變埋同一種粗線
    const extra = students.length - templateStudentRows;
    for (let i = 0; i < extra; i += 1) {
      const newRowNum = headerRows + templateStudentRows + 1 + i;
      const bandPos = (templateStudentRows + i) % 5;
      const srcRow = sheet.getRow(headerRows + 1 + bandPos);
      const dstRow = sheet.getRow(newRowNum);
      dstRow.height = srcRow.height;
      srcRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        dstRow.getCell(colNumber).style = cell.style;
      });
    }
  } else if (students.length < templateStudentRows) {
    // exceljs 嘅 spliceRows() 喺刪走「一直去到最尾」嗰段列時有 bug(唔會真正刪走),
    // 所以呢度直接截斷內部 _rows 陣列,移除多餘嘅空白學生列,等匯出檔案乾淨,冇多餘 #DIV/0! 錯誤
    const lastUsedRow = headerRows + students.length;
    sheet._rows.length = lastUsedRow;
  }

  const colLetter = (col) => sheet.getColumn(col).letter;
  students.forEach((student, idx) => {
    const r = headerRows + 1 + idx;
    sheet.getCell(r, 1).value = student.seatNo;
    sheet.getCell(r, 2).value = student.name;

    const writeScores = (startCol, dateList, dataMap) => {
      dateList.forEach((d, i) => {
        const val = dataMap.get(d)?.get(student.id);
        sheet.getCell(r, startCol + i).value = val === undefined || val === null ? null : val;
      });
    };
    writeScores(attendanceStart, attendanceDates, attendanceMap);
    writeScores(performanceStart, performanceDates, performanceMap);
    writeScores(lessonStart, lessonDates, lessonScoreMap);

    const writeAverage = (avgCol, startCol, count) => {
      const c = sheet.getCell(r, avgCol);
      c.value = count === 0 ? null : { formula: `AVERAGE(${colLetter(startCol)}${r}:${colLetter(avgCol - 1)}${r})` };
    };
    writeAverage(attendanceAvgCol, attendanceStart, attendanceDates.length);
    writeAverage(performanceAvgCol, performanceStart, performanceDates.length);
    writeAverage(lessonAvgCol, lessonStart, lessonDates.length);

    const latestTest = tests && tests.length ? tests[tests.length - 1] : null;
    sheet.getCell(r, testCol).value = latestTest ? latestTest.scores.get(student.id) ?? null : null;
  });

  return workbook;
}

module.exports = { parseRosterBuffer, parseRosterWorkbookSheets, buildClassExportWorkbook };
