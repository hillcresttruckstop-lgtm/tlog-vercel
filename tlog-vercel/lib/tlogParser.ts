/**
 * tlogParser.ts
 * ==============
 * Parses VeriFone TLog XML (gzip or plain) into transaction records.
 *
 * Every exclusion/netting rule below was ported directly from the
 * production Google Apps Script (TLog Nightly/Near-Real-Time Sync) that
 * writes these same files into the monthly Google Sheets - each rule in
 * that script was individually found and verified against real closed
 * days over months of production use. This parser was previously missing
 * ALL of them, which caused real, confirmed bugs: fuel/merch revenue
 * inflated by double-logged fuel-prepay holds, no exclusion of
 * cancelled/rolled-back payment attempts, and no category (trlCat) data
 * at all for proper department-wise breakdowns. Every rule here was
 * re-verified against this account's own real sample TLog data before
 * being written (see the inline comments for what was actually found).
 */

import { gunzipSync } from "zlib";
import { XMLParser } from "fast-xml-parser";

export interface TxnLine {
  dept_number: string | null;
  dept_type: string | null;
  category: string | null; // trlCat - e.g. "TOBACCO", "DELI", "GROC NOTAX"
  description: string | null;
  qty: number | null;
  unit_price: number | null;
  line_total: number | null; // for non-fuel lines, already promo-netted
  is_fuel: boolean;
  fuel_grade: string | null;
  fuel_volume: number | null;
  pump_number: number | null;
  // An item rung up then voided WITHIN an otherwise-normal, completed
  // sale (VeriFone tags the line itself type="void plu", distinct from a
  // whole transaction being void). Confirmed real: the voided line
  // carries a NEGATIVE line_total that exactly cancels the earlier
  // positive line for the same item, so totals are already correct
  // without any special handling - this flag exists purely so these can
  // be surfaced as their own "Void Lines" list, not to change any sum.
  is_void_line: boolean;
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
  tr_seq: string | null; // the register's own sequential ticket number - a real, human-meaningful "Transaction #"
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
  isArray: (name) => ["trans", "trLine", "trPayline", "trlMatchLine"].includes(name),
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

/** The real posNum+trSeq pairing key VeriFone reuses between an original
 * attempt and its rollback mirror. This is nested under
 * trHeader > trTickNum, NOT a flat trHeader > posNum (which exists too,
 * but is a different, largely-unused field - confirmed always "0" in
 * this account's real data. Using the wrong one silently defeats
 * rollback pairing entirely, which is exactly what this parser was doing
 * before this fix.) */
function getPosSeqKey(trans: any): string | null {
  const tick = trans.trHeader?.trTickNum;
  if (!tick) return null;
  const pos = textOf(tick.posNum);
  const seq = textOf(tick.trSeq);
  if (pos === null || seq === null) return null;
  return `${pos}|${seq}`;
}

/** True if this transaction has a preFuel or void preFuel line anywhere
 * in it - VeriFone logs every fuel-prepay authorization as its own
 * "deposit" transaction (trlDept type="fuel", NO real <trlFuel> child)
 * separate from the real completion sale that follows it. Confirmed in
 * this account's own real data: a $20.00 "FUEL DEPOSIT" line with
 * trlDept type="fuel" but no <trlFuel> element - our old is_fuel check
 * (deptType === "fuel") flagged it as real fuel revenue anyway, double-
 * counting that $20 alongside the real completion sale that records the
 * same purchase correctly. The whole transaction is excluded, matching
 * the reference implementation exactly (not just the FUEL DEPOSIT line -
 * a combo ticket bundling real merchandise with a fuel prepay would
 * otherwise still lose that merchandise's real payment/tax while keeping
 * the fake deposit line). */
function transactionHasPreFuelLine(lineList: any[]): boolean {
  for (const line of lineList) {
    const t = line["@_type"];
    if (t === "preFuel" || t === "void preFuel") return true;
  }
  return false;
}

/** Sum of every trlPromoAmount inside a merch line's mix-and-match promo
 * block. trlLineTot is the PRE-promotion price for mix-and-match items -
 * the discount only ever appears here, never folded back into
 * trlLineTot itself. Confirmed present in this account's real data (6
 * occurrences in one sample file) - without this, merch revenue is
 * overstated by whatever was given away in mix-and-match promos. */
function sumPromoAmount(line: any): number {
  const mixMatches = line.trlMixMatches;
  if (!mixMatches) return 0;
  let sum = 0;
  for (const matchLine of asArray(mixMatches.trlMatchLine)) {
    const promo = toFloat(textOf(matchLine.trlPromoAmount));
    if (promo !== null) sum += promo;
  }
  return sum;
}

function parseOneTrans(trans: any, sourceFile: string): Transaction | null {
  const transType: string = trans["@_type"];
  const header = trans.trHeader;
  if (!header) return null;

  const uniqueId = textOf(header.uniqueID);
  if (!uniqueId) return null;

  const dateStr = textOf(header.date) ?? "";
  // Real distinguishing station identifier lives under trTickNum, not the
  // flat trHeader > posNum field (see getPosSeqKey comment above).
  const posNum = toInt(textOf(header.trTickNum?.posNum));
  const trSeq = textOf(header.trTickNum?.trSeq);
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
  const rawLineList = trLines ? asArray(trLines.trLine) : [];

  for (const line of rawLineList) {
    const lineType: string = line["@_type"] ?? "";
    const isVoidLine = lineType.startsWith("void ");

    const dept = line.trlDept;
    const deptNumber = dept ? dept["@_number"] ?? null : null;
    const deptType = dept ? dept["@_type"] ?? null : null;
    const deptName = dept ? textOf(dept) : null;
    const category = textOf(line.trlCat);

    const qty = toFloat(textOf(line.trlQty));
    const unitPrice = toFloat(textOf(line.trlUnitPrice));
    const rawLineTotal = toFloat(textOf(line.trlLineTot));
    const desc = textOf(line.trlDesc) ?? deptName;

    // Only a REAL <trlFuel> child means real fuel data - a "fuel"-typed
    // department with no trlFuel child (the FUEL DEPOSIT pattern above)
    // is not actually a fuel line, it just shares the department type.
    const fuel = line.trlFuel;
    const isFuel = !!fuel;
    let fuelGrade: string | null = null;
    let fuelVolume: number | null = null;
    let pumpNumber: number | null = null;
    let lineTotal = rawLineTotal;

    if (fuel) {
      fuelGrade = textOf(fuel.fuelProd) ?? deptName;
      fuelVolume = toFloat(textOf(fuel.fuelVolume));
      pumpNumber = toInt(textOf(fuel.fuelPosition));
    } else if (rawLineTotal !== null) {
      // Merch line: net out any mix-and-match promo discount, matching
      // the reference implementation exactly.
      const promo = sumPromoAmount(line);
      lineTotal = promo > 0 ? rawLineTotal - promo : rawLineTotal;
    }

    if (isFuel && pumpNumber === null && desc) {
      const m = desc.match(/#(\d+)/);
      if (m) pumpNumber = parseInt(m[1], 10);
    }

    lines.push({
      dept_number: deptNumber,
      dept_type: deptType,
      category,
      description: desc,
      qty,
      unit_price: unitPrice,
      line_total: lineTotal,
      is_fuel: isFuel,
      fuel_grade: fuelGrade,
      fuel_volume: fuelVolume,
      pump_number: pumpNumber,
      is_void_line: isVoidLine,
    });
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
    tr_seq: trSeq,
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

// A void ticket has the exact same shape as a normal Transaction (full
// header, totals, and line items) - VeriFone tags it type="void" but
// otherwise structures it identically, confirmed against real data. Reusing
// the Transaction shape (rather than a separate lightweight record) is what
// lets a void ticket be displayed with the same detail view as any other
// transaction - the whole point of surfacing them as real "tickets," not
// just a bare count.
export type VoidTicket = Transaction;

export interface ParseResult {
  transactions: Transaction[];
  voidTickets: VoidTicket[];
}

export function parseTlog(rawBytes: Buffer, sourceFile: string): ParseResult {
  const transSet = loadTransSet(rawBytes);
  const allTrans = asArray(transSet.trans);

  // PASS 1: find every (posNum, trSeq) pair that has a rollback="true"
  // record anywhere - a cancelled/declined payment attempt, not a real
  // sale, and its paired original attempt must be excluded too. Confirmed
  // real in this account's own data (1 occurrence in one sample file).
  const rollbackKeys = new Set<string>();
  for (const trans of allTrans) {
    if (trans["@_rollback"] === "true") {
      const key = getPosSeqKey(trans);
      if (key) rollbackKeys.add(key);
    }
  }

  // PASS 2: process real sales, applying every exclusion in the same
  // order as the reference implementation. "void" transactions are
  // tracked SEPARATELY (voidTickets) rather than mixed into the same list
  // as real sales - keeping them fully separate means no existing
  // revenue/transaction-count query needs to remember to filter them
  // back out, which is exactly the kind of easy-to-forget mistake that
  // caused the fuel-deposit double-counting bug this parser already
  // fixed once.
  const out: Transaction[] = [];
  const voidTickets: VoidTicket[] = [];

  for (const trans of allTrans) {
    const type = trans["@_type"];

    if (type === "void") {
      const parsed = parseOneTrans(trans, sourceFile);
      if (parsed) voidTickets.push(parsed);
      continue;
    }

    // "sale" and "network sale" are the two everyday transaction types.
    // "refund sale" / "refund network sale" are real (confirmed 7/22/2026
    // and 6/10/2026 in the reference system) - their line amounts are
    // already negative, so including them correctly nets returns against
    // gross sales instead of silently overstating revenue by the refund
    // amount, which is what excluding them entirely would do.
    if (type !== "sale" && type !== "network sale" && type !== "refund sale" && type !== "refund network sale") {
      continue;
    }

    const key = getPosSeqKey(trans);
    if (key && rollbackKeys.has(key)) continue; // cancelled attempt - not a real sale

    const suspendedAttr = trans["@_suspended"];
    if (suspendedAttr === "true") continue; // parked sale, not yet paid - not a real sale (yet)

    const trLines = trans.trLines;
    const rawLineList = trLines ? asArray(trLines.trLine) : [];
    if (transactionHasPreFuelLine(rawLineList)) continue; // fuel-prepay hold, see comment above

    const parsed = parseOneTrans(trans, sourceFile);
    if (!parsed) continue;

    // Pump pre-authorization ping: VeriFone logs the moment a customer
    // taps their card to START the pump as its own type="sale" record,
    // before any fuel has actually been pumped - confirmed real: qty
    // 0.000, volume 0.000, price $0.00, and critically NO payment record
    // at all (no trPaylines element - nothing was actually charged). A
    // real completed sale always has at least one payment; this doesn't,
    // which is what distinguishes it from a genuine (rare but possible)
    // $0.00 comped/promotional sale that WOULD still carry a real $0
    // tender line. The real purchase arrives later as its own separate
    // transaction with the actual amount once fueling finishes - that one
    // is parsed and counted completely normally.
    if (parsed.total_with_tax === 0 && parsed.payments.length === 0) continue;

    out.push(parsed);
  }
  return { transactions: out, voidTickets };
}
