// fake-google.js: pretend versions of the Google services Code.gs uses, for tests.
//
// FakeSpreadsheet / FakeSheet / FakeRange copy just enough of SpreadsheetApp for the studio
// sheet and the time sheet: values, number formats, dropdown rules, checkboxes, frozen panes,
// column widths, protections, inserting tabs and rows, and format-only / dropdown-only pastes.
// Every change is recorded in spreadsheet.writes, so tests can check exactly which cells were
// written.
//
// Dropdown rules: FakeRule({ range, allowInvalid }) is a "list from a range" dropdown; type
// "VALUE_IN_LIST" takes a typed-in list (what SpreadsheetApp.newDataValidation() builds here), and
// type "CHECKBOX" is a checkbox (an unticked box holds FALSE). With spreadsheet option
// rejectInvalidScriptWrites: true, a script write that a "Reject input" rule (allowInvalid: false)
// doesn't allow throws like a refused write would, and nothing is written. That lets tests check
// the plain-English error path; it is NOT a claim about what Google does.
//
// Pastes: copyTo(destination) copies everything; with CopyPasteType.PASTE_FORMAT it copies only
// number formats and styles (deliberately NOT dropdowns, the stricter reading of Google's docs,
// so code must also paste PASTE_DATA_VALIDATION), and with PASTE_DATA_VALIDATION only the rules.
import { formatDate, makeParseDate } from "./gas-sandbox.js";

const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";

// "A1"-style name of a cell: column letters plus row number.
export function cellName(row, col) {
  let letters = "";
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters + row;
}

const isBlank = (v) => v === "" || v === null || v === undefined;

// A dropdown rule. type "VALUE_IN_RANGE" takes its choices from `range` (a FakeRange);
// "VALUE_IN_LIST" from `list`; "CHECKBOX" is a checkbox (TRUE or FALSE).
// allowInvalid false = "Reject input", true = "Show a warning".
export class FakeRule {
  constructor({ type = "VALUE_IN_RANGE", range = null, list = null, allowInvalid = false, showDropdown = true } = {}) {
    this.type = type;
    this.range = range;
    this.list = list;
    this.allowInvalid = allowInvalid;
    this.showDropdown = showDropdown;
  }
  getCriteriaType() { return this.type; }
  getCriteriaValues() {
    if (this.type === "CHECKBOX") return [];
    return this.type === "VALUE_IN_RANGE" ? [this.range, this.showDropdown] : [this.list.slice(), this.showDropdown];
  }
  getAllowInvalid() { return this.allowInvalid; }
  allows(value) {
    if (isBlank(value)) return true;
    if (this.type === "CHECKBOX") return typeof value === "boolean";
    const choices = this.type === "VALUE_IN_RANGE"
      ? this.range.getValues().flat().filter((v) => !isBlank(v))
      : this.list;
    return choices.some((c) => typeof c === typeof value && String(c) === String(value));
  }
}

export class FakeSpreadsheet {
  constructor({ id, name, timeZone = "America/New_York", url, rejectInvalidScriptWrites = false, SandboxDate }) {
    this.id = id;
    this.name = name;
    this.timeZone = timeZone;
    this.url = url || `https://docs.google.com/spreadsheets/d/${id}/edit`;
    this.rejectInvalidScriptWrites = rejectInvalidScriptWrites;
    this.SandboxDate = SandboxDate;
    this.sheets = [];
    this.writes = [];
    this.nextSheetId = 0;
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return this.url; }
  getSpreadsheetTimeZone() { return this.timeZone; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  // Test helper: adds a tab at the end (not recorded as a script write).
  addSheet(name, options) {
    const sheet = new FakeSheet(this, name, options);
    this.sheets.push(sheet);
    return sheet;
  }
  insertSheet(name, index) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const sheet = new FakeSheet(this, name);
    const at = index === undefined ? this.sheets.length : Math.max(0, Math.min(index, this.sheets.length));
    this.sheets.splice(at, 0, sheet);
    this.writes.push({ kind: "insertSheet", sheet: name, index: at });
    return sheet;
  }
  record(entry) { this.writes.push(entry); }
}

export class FakeSheet {
  constructor(ss, name, { maxRows = 1000, maxColumns = 26 } = {}) {
    this.ss = ss;
    this.name = name;
    // Like Google: the first tab is 0, later ones get big made-up numbers.
    this.sheetId = ss.nextSheetId === 0 ? 0 : 1000000 + ss.nextSheetId * 7919;
    ss.nextSheetId++;
    this.maxRows = maxRows;
    this.maxColumns = maxColumns;
    this.cells = new Map(); // "row,col" → { value, format, rule, style, note }
    this.frozenRows = 0;
    this.frozenColumns = 0;
    this.widths = {};
    this.protections = [];
    this.failWrite = null; // test hook: (row, col) => message to throw, or null
  }
  cell(row, col) {
    const key = row + "," + col;
    if (!this.cells.has(key)) this.cells.set(key, { value: "", format: null, rule: null, style: {}, note: null, formula: "" });
    return this.cells.get(key);
  }
  peek(row, col) { return this.cells.get(row + "," + col) || null; }
  // Test helper: the stored value of one cell ("" when empty).
  valueAt(row, col) { const c = this.peek(row, col); return c ? c.value : ""; }
  // Test helper: writes one row of values starting at column A (not recorded as a script write).
  putRow(row, values) {
    values.forEach((v, i) => { this.cell(row, i + 1).value = isDate(v) ? new Date(v.getTime()) : v; });
  }
  getName() { return this.name; }
  getSheetId() { return this.sheetId; }
  getParent() { return this.ss; }
  getIndex() { return this.ss.sheets.indexOf(this) + 1; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }
  getLastRow() {
    let last = 0;
    for (const [key, c] of this.cells) if (!isBlank(c.value)) last = Math.max(last, Number(key.split(",")[0]));
    return last;
  }
  getLastColumn() {
    let last = 0;
    for (const [key, c] of this.cells) if (!isBlank(c.value)) last = Math.max(last, Number(key.split(",")[1]));
    return last;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row !== "number") throw new Error("FakeSheet.getRange: only numeric ranges are supported");
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1 ||
        row + numRows - 1 > this.maxRows || col + numCols - 1 > this.maxColumns) {
      throw new Error("The coordinates of the range are outside the dimensions of the sheet.");
    }
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }
  insertRowsAfter(after, count) {
    const moved = new Map();
    for (const [key, c] of this.cells) {
      const [r, col] = key.split(",").map(Number);
      moved.set((r > after ? r + count : r) + "," + col, c);
    }
    this.cells = moved;
    this.maxRows += count;
    this.ss.record({ kind: "insertRows", sheet: this.name, after, count });
  }
  insertColumnsAfter(after, count) {
    this.maxColumns += count;
    this.ss.record({ kind: "insertColumns", sheet: this.name, after, count });
  }
  setFrozenRows(n) { this.frozenRows = n; this.ss.record({ kind: "frozenRows", sheet: this.name, n }); }
  getFrozenRows() { return this.frozenRows; }
  setFrozenColumns(n) { this.frozenColumns = n; this.ss.record({ kind: "frozenColumns", sheet: this.name, n }); }
  getFrozenColumns() { return this.frozenColumns; }
  getColumnWidth(col) { return this.widths[col] || 100; }
  setColumnWidth(col, width) {
    this.widths[col] = width;
    this.ss.record({ kind: "columnWidth", sheet: this.name, col, width });
    return this;
  }
  autoResizeColumn() { return this; }
  getProtections() { return this.protections.slice(); }
  getBandings() { return []; }
  // Writes a row just below the last row with anything in it (recorded like setValues).
  appendRow(values) {
    this.getRange(this.getLastRow() + 1, 1, 1, values.length).setValues([values]);
    return this;
  }
}

export class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getSheet() { return this.sheet; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  forEachCell(fn) {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) fn(this.row + r, this.col + c, r, c);
    }
  }
  grid(read) {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(read(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValues() {
    const SandboxDate = this.sheet.ss.SandboxDate;
    return this.grid((r, c) => {
      const cell = this.sheet.peek(r, c);
      const v = cell ? cell.value : "";
      return isDate(v) ? new SandboxDate(v.getTime()) : v;
    });
  }
  getValue() { return this.getValues()[0][0]; }
  getFormulas() { return this.grid((r, c) => { const cell = this.sheet.peek(r, c); return (cell && cell.formula) || ""; }); }
  setValues(values) {
    if (values.length !== this.numRows || values.some((line) => line.length !== this.numCols)) {
      throw new Error(`The number of rows or columns in the data does not match the range (${this.numRows}x${this.numCols}).`);
    }
    // A test can make one cell refuse writes.
    this.forEachCell((r, c, i, j) => {
      const message = this.sheet.failWrite && this.sheet.failWrite(r, c, values[i][j]);
      if (message) throw new Error(message);
    });
    // "Reject input" dropdowns refuse a value that isn't a choice (only when the test asks).
    if (this.sheet.ss.rejectInvalidScriptWrites) {
      this.forEachCell((r, c, i, j) => {
        const cell = this.sheet.peek(r, c);
        if (cell && cell.rule && !cell.rule.getAllowInvalid() && !cell.rule.allows(values[i][j])) {
          throw new Error(`Exception: The data you entered in cell ${cellName(r, c)} violates the data validation rules set on this cell.`);
        }
      });
    }
    this.forEachCell((r, c, i, j) => {
      const v = values[i][j];
      this.sheet.cell(r, c).value = isDate(v) ? new Date(v.getTime()) : v;
    });
    this.sheet.ss.record({
      kind: "values", sheet: this.sheet.name, row: this.row, col: this.col,
      numRows: this.numRows, numCols: this.numCols,
      values: values.map((line) => line.map((v) => (isDate(v) ? new Date(v.getTime()) : v))),
    });
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  getNumberFormat() { const c = this.sheet.peek(this.row, this.col); return (c && c.format) || "General"; }
  setNumberFormat(format) {
    this.forEachCell((r, c) => { this.sheet.cell(r, c).format = format; });
    this.sheet.ss.record({ kind: "numberFormat", sheet: this.sheet.name, row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols, format });
    return this;
  }
  getDataValidation() { const c = this.sheet.peek(this.row, this.col); return (c && c.rule) || null; }
  getDataValidations() { return this.grid((r, c) => { const cell = this.sheet.peek(r, c); return (cell && cell.rule) || null; }); }
  setDataValidation(rule) {
    this.forEachCell((r, c) => { this.sheet.cell(r, c).rule = rule; });
    this.sheet.ss.record({ kind: "validation", sheet: this.sheet.name, row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols, rule });
    return this;
  }
  // Copies values, number formats, styles and dropdowns, like a normal paste. With a paste type,
  // PASTE_FORMAT copies only number formats and styles, PASTE_DATA_VALIDATION only dropdowns.
  copyTo(destination, type = "PASTE_NORMAL") {
    const formats = type === "PASTE_NORMAL" || type === "PASTE_FORMAT";
    const rules = type === "PASTE_NORMAL" || type === "PASTE_DATA_VALIDATION";
    const values = type === "PASTE_NORMAL";
    if (!formats && !rules) throw new Error(`FakeRange.copyTo: paste type ${type} is not supported`);
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        const from = this.sheet.peek(this.row + r, this.col + c);
        const to = destination.sheet.cell(destination.row + r, destination.col + c);
        if (values) to.value = from ? (isDate(from.value) ? new Date(from.value.getTime()) : from.value) : "";
        if (formats) {
          to.format = from ? from.format : null;
          to.style = from ? Object.assign({}, from.style) : {};
        }
        if (rules) to.rule = from ? from.rule : null;
      }
    }
    destination.sheet.ss.record({ kind: "copy", type, from: this.sheet.name, fromRow: this.row, sheet: destination.sheet.name, row: destination.row, col: destination.col, numRows: this.numRows, numCols: this.numCols });
  }
  style(key, value) {
    this.forEachCell((r, c) => { this.sheet.cell(r, c).style[key] = value; });
    this.sheet.ss.record({ kind: "style", sheet: this.sheet.name, row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols, key, value });
    return this;
  }
  setFontWeight(v) { return this.style("fontWeight", v); }
  setFontColor(v) { return this.style("fontColor", v); }
  setBackground(v) { return this.style("background", v); }
  setFontStyle(v) { return this.style("fontStyle", v); }
  setVerticalAlignment(v) { return this.style("verticalAlignment", v); }
  setWrap(v) { return this.style("wrap", v); }
  applyRowBanding() {
    const banding = {
      setHeaderRowColor: () => banding,
      setFirstRowColor: () => banding,
      setSecondRowColor: () => banding,
      remove: () => {},
    };
    this.sheet.ss.record({ kind: "banding", sheet: this.sheet.name });
    return banding;
  }
  setNote(note) {
    this.sheet.cell(this.row, this.col).note = note;
    this.sheet.ss.record({ kind: "note", sheet: this.sheet.name, row: this.row, col: this.col, note });
    return this;
  }
  protect() {
    const sheet = this.sheet;
    const p = {
      range: this,
      description: "",
      warningOnly: false,
      setDescription(d) { p.description = d; return p; },
      getDescription() { return p.description; },
      setWarningOnly(w) { p.warningOnly = w; return p; },
      getRange() { return p.range; },
      remove() { sheet.protections = sheet.protections.filter((x) => x !== p); },
    };
    sheet.protections.push(p);
    sheet.ss.record({ kind: "protect", sheet: sheet.name, row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols });
    return p;
  }
}

// Builds every fake global Code.gs needs. `spreadsheets` maps an ID to a FakeSpreadsheet;
// `active` is the studio spreadsheet the script is attached to. `effectiveUser` is the account
// the script runs as; `activeUser` is the person using it (the same person when someone runs a
// function from the editor; a page visitor otherwise). Change it with setActiveUser().
// `htmlFiles` lists the HTML files in the Apps Script project (by name).
export function fakeGlobals({
  SandboxDate, active, spreadsheets = {}, props = {},
  effectiveUser = "script.owner@example.org", activeUser, htmlFiles = ["Index"],
}) {
  const logs = [];
  const openCalls = [];
  const store = Object.assign({}, props);
  let lockHeld = false;
  // Test hook: (key) => true makes setProperty throw for that key, like a full or busy store.
  let failSetProperty = null;
  let currentActive = activeUser === undefined ? effectiveUser : activeUser;

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => active,
    openById: (id) => {
      openCalls.push(id);
      const ss = spreadsheets[id];
      if (!ss) throw new Error("Exception: Unexpected error while getting the method or property openById on object SpreadsheetApp.");
      return ss;
    },
    flush: () => {},
    // newDataValidation().requireValueInList(list, showDropdown).setAllowInvalid(b).build()
    newDataValidation: () => {
      const spec = { type: null, list: null, showDropdown: true, allowInvalid: false };
      const builder = {
        requireValueInList: (list, showDropdown = true) => {
          spec.type = "VALUE_IN_LIST";
          spec.list = Array.from(list);
          spec.showDropdown = showDropdown;
          return builder;
        },
        requireCheckbox: () => { spec.type = "CHECKBOX"; return builder; },
        setAllowInvalid: (allow) => { spec.allowInvalid = !!allow; return builder; },
        build: () => {
          if (!spec.type) throw new Error("newDataValidation fake: no criteria set");
          return new FakeRule(spec);
        },
      };
      return builder;
    },
    CopyPasteType: {
      PASTE_NORMAL: "PASTE_NORMAL",
      PASTE_FORMAT: "PASTE_FORMAT",
      PASTE_DATA_VALIDATION: "PASTE_DATA_VALIDATION",
    },
    DataValidationCriteria: { VALUE_IN_RANGE: "VALUE_IN_RANGE", VALUE_IN_LIST: "VALUE_IN_LIST", CHECKBOX: "CHECKBOX" },
    ProtectionType: { RANGE: "RANGE", SHEET: "SHEET" },
    BandingTheme: { LIGHT_GREY: "LIGHT_GREY" },
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setProperty: (k, v) => {
        if (failSetProperty && failSetProperty(k)) throw new Error("Exception: Service invoked too many times for one day: properties.");
        store[k] = String(v);
      },
      deleteProperty: (k) => { delete store[k]; },
    }),
  };

  // Strict on purpose: taking the lock while it's already held throws, so a test catches code
  // that would wait on itself in Apps Script.
  const LockService = {
    getScriptLock: () => ({
      tryLock: () => {
        if (lockHeld) throw new Error("nested script lock");
        lockHeld = true;
        return true;
      },
      releaseLock: () => { lockHeld = false; },
    }),
  };

  const Utilities = {
    formatDate,
    parseDate: makeParseDate(SandboxDate),
    sleep: () => {},
    base64Encode: (s) => Buffer.from(String(s)).toString("base64"),
  };

  const Logger = { log: (...args) => { logs.push(args.map(String).join(" ")); } };
  const Session = {
    getEffectiveUser: () => ({ getEmail: () => effectiveUser }),
    getActiveUser: () => ({ getEmail: () => currentActive }),
  };
  // HtmlService: an output remembers where it came from, its title and its meta tags.
  const htmlOutput = (from, content) => {
    const out = {
      from, content, title: "", meta: {},
      setTitle: (t) => { out.title = t; return out; },
      getTitle: () => out.title,
      addMetaTag: (name, value) => { out.meta[name] = value; return out; },
      getContent: () => out.content,
    };
    return out;
  };
  const HtmlService = {
    createHtmlOutputFromFile: (name) => {
      if (!htmlFiles.includes(name)) throw new Error(`No HTML file named ${name} was found.`);
      return htmlOutput("file:" + name, `<!-- contents of ${name}.html -->`);
    },
    createHtmlOutput: (html) => htmlOutput("string", String(html)),
  };
  const ContentService = {
    MimeType: { JSON: "JSON" },
    createTextOutput: (text) => {
      const out = { text, setMimeType: () => out, getContent: () => text };
      return out;
    },
  };
  const CalendarApp = { getDefaultCalendar: () => ({ getName: () => "Studio Calendar", getId: () => "studio-calendar" }) };
  const DriveApp = {
    getRootFolder: () => ({ getName: () => "My Drive" }),
    getFolderById: () => { throw new Error("No item with the given ID could be found."); },
  };

  return {
    globals: { SpreadsheetApp, PropertiesService, LockService, Utilities, Logger, Session, ContentService, CalendarApp, DriveApp, HtmlService },
    logs,
    setActiveUser: (email) => { currentActive = email; },
    failPropertyWrites: (fn) => { failSetProperty = fn; },
    openCalls,
    props: store,
    isLockHeld: () => lockHeld,
  };
}
