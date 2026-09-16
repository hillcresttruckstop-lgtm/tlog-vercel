/**
 * tlogParser.ts
 * ==============
 * Parses VeriFone TLog XML (gzip or plain) into transaction records.
 * This is a direct TypeScript port of the Python parser that was tested
 * against real current.1.xml.gz / current.2.xml.gz files on 9/16/2026 -
 * same field mapping, same "sale" + "network sale" filter, same fuel/pump
 * extraction logic.
 */

import { gunzipSync } from "zlib";
import { XMLParser } from "fast-xml-parser";

export interface TxnLine {
  dept_number: string | null;
  dept_type: string | null;
  description: string | null;
  qty: number | null;
  unit_price: number | null;
  line_total: number | null;
  is_fuel: boolean;
  fuel_grade: string | null;
  fuel_volume: number | null;
  pump_number: number | null;
}

export interface TxnPayment {
  tender_type: string;
  amount: number | null;
  card_last4: string | null;
}

export interface Transaction {
  unique_id: string;
  source_file: string;
  trans_type: string;
  pos_num: number | null;
  date: string;
  cashier: string | null;
  till: number | null;
  total_no_tax: number | null;
  total_with_tax: number | null;
  total_tax: number | null;
  lines: TxnLine[];
  payments: TxnPayment[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["trans", "trLine", "trPayline"].includes(name),
});

function toFloat(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isNaN(n) ? null : n;
}

function toInt(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

function textOf(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if ("#text" in obj) return String(obj["#text"]).trim();
    return null;
  }
  return String(node).trim();
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function loadTransSet(rawBytes: Buffer): any {
  let bytes = rawBytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = gunzipSync(bytes);
  }
  const xml = bytes.toString("utf-8");
  const doc = parser.parse(xml);
  return doc.transSet;
}

function parseOneTrans(trans: any, sourceFile: string): Transaction | null {
  const transType: string = trans["@_type"];
  const header = trans.trHeader;
  if (!header) return null;

  const uniqueId = textOf(header.uniqueID);
  if (!uniqueId) return null;

  const dateStr = textOf(header.date) ?? "";
  const posNum = toInt(textOf(header.posNum));
  const till = toInt(textOf(header.till));
  const cashierRaw = header.cashier;
  const cashier =
    cashierRaw && typeof cashierRaw === "object" && "#text" in cashierRaw
      ? String(cashierRaw["#text"]).trim()
      : null;

  const value = trans.trValue;
  const totalNoTax = value ? toFloat(textOf(value.trTotNoTax)) : null;
  const totalWithTax = value ? toFloat(textOf(value.trTotWTax)) : null;
  const totalTax = value ? toFloat(textOf(value.trTotTax)) : null;

  const lines: TxnLine[] = [];
  const trLines = trans.trLines;
  if (trLines) {
    for (const line of asArray(trLines.trLine)) {
      const dept = line.trlDept;
      const deptNumber = dept ? dept["@_number"] ?? null : null;
      const deptType = dept ? dept["@_type"] ?? null : null;
      const deptName = dept ? textOf(dept) : null;

      const qty = toFloat(textOf(line.trlQty));
      const unitPrice = toFloat(textOf(line.trlUnitPrice));
      const lineTotal = toFloat(textOf(line.trlLineTot));
      const desc = textOf(line.trlDesc) ?? deptName;

      const fuel = line.trlFuel;
      const isFuel = deptType === "fuel" || !!fuel;
      let fuelGrade: string | null = null;
      let fuelVolume: number | null = null;
      let pumpNumber: number | null = null;

      if (fuel) {
        fuelGrade = textOf(fuel.fuelProd) ?? deptName;
        fuelVolume = toFloat(textOf(fuel.fuelVolume));
        pumpNumber = toInt(textOf(fuel.fuelPosition));
      } else if (isFuel) {
        fuelGrade = deptName;
      }

      if (isFuel && pumpNumber === null && desc) {
        const m = desc.match(/#(\d+)/);
        if (m) pumpNumber = parseInt(m[1], 10);
      }

      lines.push({
        dept_number: deptNumber,
        dept_type: deptType,
        description: desc,
        qty,
        unit_price: unitPrice,
        line_total: lineTotal,
        is_fuel: isFuel,
        fuel_grade: fuelGrade,
        fuel_volume: fuelVolume,
        pump_number: pumpNumber,
      });
    }
  }

  const payments: TxnPayment[] = [];
  const trPaylines = trans.trPaylines;
  if (trPaylines) {
    for (const payline of asArray(trPaylines.trPayline)) {
      const tenderType = textOf(payline.trpPaycode) ?? "UNKNOWN";
      const amount = toFloat(textOf(payline.trpAmt));
      const cardInfo = payline.trpCardInfo;
      let cardLast4: string | null = null;
      if (cardInfo) {
        const acct = textOf(cardInfo.trpcAccount);
        if (acct) cardLast4 = acct.slice(-4);
      }
      payments.push({ tender_type: tenderType, amount, card_last4: cardLast4 });
    }
  }

  return {
    unique_id: uniqueId,
    source_file: sourceFile,
    trans_type: transType,
    pos_num: posNum,
    date: dateStr,
    cashier,
    till,
    total_no_tax: totalNoTax,
    total_with_tax: totalWithTax,
    total_tax: totalTax,
    lines,
    payments,
  };
}

export function parseTlog(rawBytes: Buffer, sourceFile: string): Transaction[] {
  const transSet = loadTransSet(rawBytes);
  const out: Transaction[] = [];
  for (const trans of asArray(transSet.trans)) {
    const type = trans["@_type"];
    if (type !== "sale" && type !== "network sale") continue;
    const parsed = parseOneTrans(trans, sourceFile);
    if (parsed) out.push(parsed);
  }
  return out;
}
