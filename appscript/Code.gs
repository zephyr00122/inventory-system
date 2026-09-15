const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const SHEET_INVENTORY = "Inventory";
const SHEET_LOGS = "Logs";
const SHEET_TEMP = "TempScan";

const INVENTORY_HEADERS = ["品名", "數量", "倉庫", "地點", "位置", "序號", "備註", "警戒值", "最後更新時間", "分類"];
const LOG_HEADERS = ["時間", "類型", "品名", "變動數量", "結餘", "異動者", "備註", "使用地點", "序號", "倉庫", "地點", "位置", "分類", "交易ID"];
const TEMP_HEADERS = ["接收時間", "掃描內容", "狀態", "掃描ID"];

function setup() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const invSheet = ss.getSheetByName(SHEET_INVENTORY) || ss.insertSheet(SHEET_INVENTORY);
  ensureHeaders(invSheet, INVENTORY_HEADERS);
  invSheet.getRange("F:F").setNumberFormat("@");

  const logSheet = ss.getSheetByName(SHEET_LOGS) || ss.insertSheet(SHEET_LOGS);
  ensureHeaders(logSheet, LOG_HEADERS);
  logSheet.getRange("I:I").setNumberFormat("@");
  logSheet.getRange("N:N").setNumberFormat("@");

  const tempSheet = ss.getSheetByName(SHEET_TEMP) || ss.insertSheet(SHEET_TEMP);
  ensureHeaders(tempSheet, TEMP_HEADERS);
}

function ensureHeaders(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }

  const width = Math.max(sheet.getLastColumn(), headers.length);
  const existing = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  let changed = false;

  headers.forEach((header, index) => {
    if (!existing[index]) {
      sheet.getRange(1, index + 1).setValue(header);
      changed = true;
    }
  });

  if (changed) SpreadsheetApp.flush();
}

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  if (!e.parameter.action) {
    const body = e.postData && e.postData.contents ? e.postData.contents : "";
    if (!body || (body.indexOf('"action"') === -1 && body.indexOf('action=') === -1)) {
      return handleExternalScan(e);
    }
  }
  return handleRequest(e);
}

function handleExternalScan(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return textOutput("Busy");

  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const tempSheet = ss.getSheetByName(SHEET_TEMP) || ss.insertSheet(SHEET_TEMP);
    ensureHeaders(tempSheet, TEMP_HEADERS);

    let content = "";
    if (e.postData && e.postData.contents) {
      try {
        const json = JSON.parse(e.postData.contents);
        content = json.barcode || json.code || json.content || json.qr || "";
      } catch (err) {
        content = e.postData.contents;
      }
    } else if (e.parameter && e.parameter.code) {
      content = e.parameter.code;
    }

    content = String(content || "").trim();
    if (!content) return textOutput("No Content");

    const scanId = Utilities.getUuid();
    tempSheet.appendRow([new Date(), content, "pending", scanId]);
    return textOutput("OK");
  } catch (error) {
    return textOutput("Error");
  } finally {
    lock.releaseLock();
  }
}

function handleRequest(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return outputJSON({ status: "error", message: "系統忙碌中" });
  }

  try {
    const params = parseRequest(e);
    const action = params.action;
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const invSheet = ss.getSheetByName(SHEET_INVENTORY) || ss.insertSheet(SHEET_INVENTORY);
    const logSheet = ss.getSheetByName(SHEET_LOGS) || ss.insertSheet(SHEET_LOGS);
    const tempSheet = ss.getSheetByName(SHEET_TEMP) || ss.insertSheet(SHEET_TEMP);

    setup();

    if (action === "getInventory") {
      return getInventoryResponse(invSheet);
    }

    if (action === "getLogs") {
      return getLogsResponse(logSheet);
    }

    if (action === "getTempScans") {
      return getTempScansResponse(tempSheet);
    }

    if (action === "batchUpdate") {
      return handleBatchUpdate(params, invSheet, logSheet);
    }

    return outputJSON({ status: "error", message: "無效指令" });
  } catch (error) {
    return outputJSON({ status: "error", message: error && error.message ? error.message : String(error) });
  } finally {
    lock.releaseLock();
  }
}

function parseRequest(e) {
  let params = Object.assign({}, (e && e.parameter) || {});
  if (!params.action && e && e.postData && e.postData.contents) {
    const content = e.postData.contents;
    try {
      const parsed = JSON.parse(content);
      params = Object.assign(params, parsed);
    } catch (err) {
      content.split("&").forEach(pair => {
        const eq = pair.indexOf("=");
        if (eq < 0) return;
        const key = decodeURIComponent(pair.slice(0, eq));
        const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
        params[key] = value;
      });
    }
  }
  return params;
}

function getInventoryResponse(invSheet) {
  const data = invSheet.getDataRange().getDisplayValues();
  if (!data.length) return outputJSON({ status: "success", data: [] });

  const headers = data[0];
  const items = data.slice(1).filter(row => row.some(value => String(value).trim() !== "")).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i] == null ? "" : row[i]);
    return obj;
  });

  return outputJSON({ status: "success", data: items });
}

function getLogsResponse(logSheet) {
  const data = logSheet.getDataRange().getValues();
  if (data.length <= 1) return outputJSON({ status: "success", data: [] });

  const headers = data[0];
  const startRow = Math.max(1, data.length - 100);
  const logs = [];

  for (let i = data.length - 1; i >= startRow; i--) {
    const obj = {};
    headers.forEach((h, colIndex) => {
      const value = data[i][colIndex];
      obj[h] = h === "時間" && value instanceof Date ? value.toISOString() : String(value == null ? "" : value);
    });
    logs.push(obj);
  }

  return outputJSON({ status: "success", data: logs });
}

function getTempScansResponse(tempSheet) {
  const lastRow = tempSheet.getLastRow();
  if (lastRow <= 1) return outputJSON({ status: "success", data: [], scanIds: [] });

  const values = tempSheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const pendingRows = values
    .map((row, index) => ({ rowNumber: index + 2, content: String(row[1] || "").trim(), status: String(row[2] || "pending"), scanId: String(row[3] || "") }))
    .filter(row => row.status === "pending" && row.content);

  pendingRows.forEach(row => tempSheet.getRange(row.rowNumber, 3).setValue("consumed"));

  return outputJSON({
    status: "success",
    data: pendingRows.map(row => row.content),
    scanIds: pendingRows.map(row => row.scanId)
  });
}

function handleBatchUpdate(params, invSheet, logSheet) {
  if (!params.batchData) throw new Error("缺少數據");

  let batchData;
  try {
    batchData = typeof params.batchData === "string" ? JSON.parse(params.batchData) : params.batchData;
  } catch (error) {
    throw new Error("batchData 格式錯誤");
  }

  if (!Array.isArray(batchData) || batchData.length === 0) {
    throw new Error("沒有可處理的資料");
  }

  const transactionId = String(params.transactionId || "").trim() || buildFallbackTransactionId(params, batchData);
  const existingTransaction = findTransactionLog(logSheet, transactionId);
  if (existingTransaction) {
    return outputJSON({
      status: "success",
      duplicate: true,
      transactionId,
      message: "交易已處理，略過重複提交",
      result: existingTransaction
    });
  }

  const modifier = String(params.modifier || "").trim();
  const timestamp = parseTransactionDate(params.customDate);
  const data = invSheet.getDataRange().getDisplayValues();
  const serialIndex = buildSerialIndex(data);
  const rowUpdates = [];
  const newRows = [];
  const logRows = [];

  // 第一階段：完整驗證整批，不先寫 Sheet。
  batchData.forEach((item, itemIndex) => {
    const normalized = normalizeTransactionItem(item, itemIndex);
    const result = validateAndPlanItem(normalized, data, serialIndex, rowUpdates, newRows);
    logRows.push({
      ...result,
      modifier,
      timestamp,
      transactionId
    });
  });

  // 第二階段：一次性套用，避免一般錯誤導致 partial update。
  applyInventoryChanges(invSheet, rowUpdates, newRows, timestamp);
  appendLogRows(logSheet, logRows);

  return outputJSON({
    status: "success",
    transactionId,
    message: "成功",
    successCount: logRows.length,
    duplicate: false
  });
}

function normalizeTransactionItem(item, itemIndex) {
  const type = String(item.type || "").trim().toUpperCase();
  const barcodeInput = String(item.barcode || "").trim();
  const serials = uniqueNonEmpty(barcodeInput ? barcodeInput.split(/[\n,]+/).map(s => s.trim()) : []);
  const qtyInput = Number(item.qty);
  const name = String(item.name || "").trim();
  const warehouse = String(item.warehouse || "").trim();
  const location = String(item.location || "").trim();
  const position = String(item.position || "").trim();
  const note = String(item.note || "").trim();
  const category = String(item.category || "").trim();
  const minStock = Number(item.minStock || 0);

  if (!['IN', 'OUT', 'SET'].includes(type)) throw new Error(`第 ${itemIndex + 1} 筆：無效異動類型`);
  if (!Number.isInteger(qtyInput) || qtyInput <= 0) throw new Error(`第 ${itemIndex + 1} 筆：數量必須為正整數`);
  if (!name && serials.length === 0) throw new Error(`第 ${itemIndex + 1} 筆：請提供品名或序號`);
  if (minStock < 0) throw new Error(`第 ${itemIndex + 1} 筆：警戒值不可小於 0`);
  if (serials.length > 0 && qtyInput !== serials.length) {
    throw new Error(`第 ${itemIndex + 1} 筆：序號數量 ${serials.length} 與數量 ${qtyInput} 不一致`);
  }
  if (new Set(serials).size !== serials.length) throw new Error(`第 ${itemIndex + 1} 筆：輸入序號重複`);

  return {
    item,
    itemIndex,
    type,
    barcodeInput,
    serials,
    qtyInput,
    name,
    warehouse,
    location,
    position,
    note,
    category,
    minStock
  };
}

function buildSerialIndex(data) {
  const index = {};
  for (let i = 1; i < data.length; i++) {
    const serials = parseSerialCell(data[i][5]);
    const rowNumber = i + 1;
    serials.forEach(serial => {
      if (index[serial]) throw new Error(`資料異常：序號 ${serial} 重複存在於第 ${index[serial]} 與第 ${rowNumber} 列`);
      index[serial] = rowNumber;
    });
  }
  return index;
}

function validateAndPlanItem(tx, data, serialIndex, rowUpdates, newRows) {
  const serialRows = tx.serials.map(serial => serialIndex[serial] || null);
  const existingRows = uniqueNonEmpty(serialRows);

  if (existingRows.length > 1) {
    throw new Error(`第 ${tx.itemIndex + 1} 筆：輸入序號分屬不同庫位，請分開處理`);
  }

  let rowNumber = existingRows.length === 1 ? Number(existingRows[0]) : -1;

  if (rowNumber === -1) {
    rowNumber = findInventoryRow(data, tx.name, tx.warehouse, tx.location, tx.position);
  }

  const base = rowNumber > 0
    ? readInventoryRow(data[rowNumber - 1], rowNumber)
    : null;

  if (tx.type === 'OUT' && !base) throw new Error(`第 ${tx.itemIndex + 1} 筆：無此庫存`);

  if (tx.type === 'OUT') {
    if (tx.serials.length > 0) {
      const missing = tx.serials.filter(serial => !base.serials.includes(serial));
      if (missing.length) throw new Error(`第 ${tx.itemIndex + 1} 筆：找不到序號 ${missing.join(', ')}`);
    }
    if (tx.qtyInput > base.qty) throw new Error(`第 ${tx.itemIndex + 1} 筆：庫存不足，目前 ${base.qty}，欲出庫 ${tx.qtyInput}`);
  }

  if (tx.type === 'IN') {
    tx.serials.forEach(serial => {
      if (serialIndex[serial] && Number(serialIndex[serial]) !== rowNumber) {
        throw new Error(`第 ${tx.itemIndex + 1} 筆：序號 ${serial} 已存在於其他庫位`);
      }
    });
  }

  if (tx.type === 'SET') {
    tx.serials.forEach(serial => {
      if (serialIndex[serial] && Number(serialIndex[serial]) !== rowNumber) {
        throw new Error(`第 ${tx.itemIndex + 1} 筆：序號 ${serial} 已存在於其他庫位`);
      }
    });
  }

  const currentQty = base ? base.qty : 0;
  let finalQty;
  let logQtyChange;
  let finalSerials = base ? base.serials.slice() : [];
  let finalNote = base ? base.note : "";
  let finalCategory = base ? base.category : "";
  let usageLocation = "";

  if (tx.type === 'IN') {
    finalQty = currentQty + tx.qtyInput;
    logQtyChange = tx.qtyInput;
    tx.serials.forEach(serial => {
      if (!finalSerials.includes(serial)) finalSerials.push(serial);
    });
    if (tx.note) finalNote = tx.note;
    if (tx.category) finalCategory = tx.category;
  } else if (tx.type === 'OUT') {
    finalQty = currentQty - tx.qtyInput;
    logQtyChange = -tx.qtyInput;
    if (tx.serials.length > 0) {
      finalSerials = finalSerials.filter(serial => !tx.serials.includes(serial));
    }
    usageLocation = tx.note;
  } else {
    finalQty = tx.qtyInput;
    logQtyChange = finalQty - currentQty;
    finalSerials = tx.serials.slice();
    if (tx.note) finalNote = tx.note;
    if (tx.category) finalCategory = tx.category;
  }

  if (finalQty < 0) throw new Error(`第 ${tx.itemIndex + 1} 筆：庫存不可小於 0`);

  const logType = tx.type === 'SET'
    ? `盤點 (${logQtyChange > 0 ? '+' : ''}${logQtyChange})`
    : tx.type;

  if (base) {
    rowUpdates.push({
      rowNumber,
      qty: finalQty,
      serials: finalSerials,
      note: finalNote,
      category: finalCategory,
      timestamp: null
    });
  } else {
    newRows.push({
      name: tx.name,
      qty: finalQty,
      warehouse: tx.warehouse,
      location: tx.location,
      position: tx.position,
      serials: finalSerials,
      note: finalNote,
      minStock: tx.minStock,
      category: finalCategory
    });
  }

  return {
    name: tx.name,
    logType,
    logQtyChange,
    finalQty,
    modifier: "",
    note: tx.type === 'OUT' ? finalNote : (tx.note || finalNote),
    usageLocation,
    barcodeInput: tx.barcodeInput,
    warehouse: tx.warehouse,
    location: tx.location,
    position: tx.position,
    category: finalCategory,
    rowNumber
  };
}

function applyInventoryChanges(invSheet, rowUpdates, newRows, timestamp) {
  rowUpdates.forEach(update => {
    invSheet.getRange(update.rowNumber, 2).setValue(update.qty);
    invSheet.getRange(update.rowNumber, 6).setNumberFormat("@").setValue(update.serials.join(','));
    invSheet.getRange(update.rowNumber, 7).setValue(update.note);
    invSheet.getRange(update.rowNumber, 9).setValue(timestamp);
    invSheet.getRange(update.rowNumber, 10).setValue(update.category);
  });

  newRows.forEach(row => {
    invSheet.appendRow([
      row.name,
      row.qty,
      row.warehouse,
      row.location,
      row.position,
      row.serials.join(','),
      row.note,
      row.minStock,
      timestamp,
      row.category
    ]);
    invSheet.getRange(invSheet.getLastRow(), 6).setNumberFormat("@");
  });
}

function appendLogRows(logSheet, results) {
  if (!results.length) return;
  const startRow = logSheet.getLastRow() + 1;
  const values = results.map(result => [
    result.timestamp,
    result.logType,
    result.name,
    result.logQtyChange,
    result.finalQty,
    result.modifier,
    result.note,
    result.usageLocation,
    result.barcodeInput,
    result.warehouse,
    result.location,
    result.position,
    result.category,
    result.transactionId
  ]);

  logSheet.getRange(startRow, 1, values.length, values[0].length).setValues(values);
  logSheet.getRange(startRow, 9, values.length, 1).setNumberFormat("@");
  logSheet.getRange(startRow, 14, values.length, 1).setNumberFormat("@");
}

function findTransactionLog(logSheet, transactionId) {
  if (!transactionId || logSheet.getLastRow() <= 1) return null;
  const headers = logSheet.getRange(1, 1, 1, Math.max(logSheet.getLastColumn(), LOG_HEADERS.length)).getDisplayValues()[0];
  const txIndex = headers.indexOf("交易ID");
  if (txIndex < 0) return null;

  const values = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, headers.length).getDisplayValues();
  const match = values.find(row => row[txIndex] === transactionId);
  return match ? { transactionId } : null;
}

function buildFallbackTransactionId(params, batchData) {
  const raw = [params.modifier || "", params.customDate || "", JSON.stringify(batchData)].join("|");
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, "");
}

function parseTransactionDate(value) {
  if (!value) return new Date();
  const date = new Date(value);
  if (isNaN(date.getTime())) throw new Error("customDate 日期格式錯誤");
  return date;
}

function readInventoryRow(row, rowNumber) {
  return {
    rowNumber,
    name: String(row[0] || "").trim(),
    qty: parseInt(row[1], 10) || 0,
    warehouse: String(row[2] || "").trim(),
    location: String(row[3] || "").trim(),
    position: String(row[4] || "").trim(),
    serials: parseSerialCell(row[5]),
    note: String(row[6] || ""),
    minStock: Number(row[7] || 0),
    category: String(row[9] || "")
  };
}

function findInventoryRow(data, name, warehouse, location, position) {
  if (!name) return -1;
  for (let i = 1; i < data.length; i++) {
    if (
      String(data[i][0] || "").trim() === name &&
      String(data[i][2] || "").trim() === warehouse &&
      String(data[i][3] || "").trim() === location &&
      String(data[i][4] || "").trim() === position
    ) {
      return i + 1;
    }
  }
  return -1;
}

function parseSerialCell(value) {
  return uniqueNonEmpty(String(value || "").split(',').map(s => s.trim()));
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter(value => value !== null && value !== undefined && String(value).trim() !== "").map(String))];
}

function textOutput(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}

function outputJSON(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
