import { getTableName, SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();
const defaults: Record<string, Record<string, unknown>> = {
  coin_settings: { id: 1, buyPrice: "50.00", sellPrice: "50.00", buyFee: "1.00", sellFee: "1.00", buyFeeEnabled: 1, sellFeeEnabled: 1, transferMinimum: "2.000000" },
  coin_treasuries: { id: 1, totalCoins: "100.000000", availableCoins: "100.000000", reservedCoins: "0.000000", buyCashBalance: "0.00", sellFundingBalance: "10000.00", reservedSellCash: "0.00", totalBuyCollected: "0.00", totalSellPaid: "0.00" },
  coin_wallets: { balance: "0.000000", reserved: "0.000000" },
  wallets: { balance: "0.00", reservedOrders: "0.00", reservedWithdrawals: "0.00", reservedTransfers: "0.00", reservedSavings: "0.00" },
};
function expression(value: SQL, row: any): any {
  const query = dialect.sqlToQuery(value);
  let index = 0;
  let source = query.sql.replace(/`[^`]+`\.`([^`]+)`/g, (_all, column) => `NumberOrString(row[${JSON.stringify(column)}])`);
  source = source.replace(/\?/g, () => JSON.stringify(query.params[index++]));
  source = source.replace(/\bIN\s*\(([^)]+)\)/gi, (_all, values) => `INPLACE(${values})`);
  source = source.replace(/NumberOrString\((row\[[^\]]+\])\)\s*INPLACE\(([^)]+)\)/g, (_all, field, values) => `[${values}].includes(${field})`);
  source = source.replace(/\band\b/gi, "&&").replace(/\bor\b/gi, "||").replace(/(?<![<>!=])=(?!=)/g, "==");
  return Function("row", "NumberOrString", `return (${source});`)(row, (item: any) => typeof item === "string" && /^-?\d+(?:\.\d+)?$/.test(item) ? Number(item) : item);
}
/** Mock-only adapter. Transaction mutex tests application replay semantics, NOT InnoDB locks. */
export class FinanceMemoryDb {
  tables: Record<string, any[]> = {};
  calls: { kind: string; table: string; lock?: string }[] = [];
  failInsertTable: string | null = null;
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();
  inTransaction = false;
  seed(table: any, rows: any[]) { this.tables[getTableName(table)] = structuredClone(rows); }
  rows(table: any) { return this.tables[getTableName(table)] ?? []; }
  async transaction(work: (tx: any) => Promise<any>) {
    const current = this.tail.then(async () => {
      const snapshot = structuredClone(this.tables);
      this.inTransaction = true;
      try { return await work(this); }
      catch (error) { this.tables = snapshot; throw error; }
      finally { this.inTransaction = false; }
    });
    this.tail = current.catch(() => undefined);
    return current;
  }
  select(selection?: any) {
    const db = this;
    let table: any, predicate: SQL | undefined, count = Infinity, offset = 0, lock: string | undefined;
    const query: any = {
      from(value: any) { table = value; return query; },
      where(value: SQL) { predicate = value; return query; },
      for(value: string) { lock = value; return query; },
      limit(value: number) { count = value; return query; },
      offset(value: number) { offset = value; return query; },
      orderBy() { return query; },
      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          const name = getTableName(table);
          db.calls.push({ kind: "select", table: name, lock });
          const result = db.rows(table).filter(row => !predicate || expression(predicate, row));
          if (selection?.total instanceof SQL) return [{ total: result.length }];
          return result.slice(offset, offset + count).map(row => selection ? Object.fromEntries(Object.entries(selection).map(([key, value]: [string, any]) => [key, row[value.name]])) : structuredClone(row));
        }).then(resolve, reject);
      },
    };
    return query;
  }
  insert(table: any) {
    const db = this, name = getTableName(table);
    let values: any, duplicateSet: any;
    const query: any = {
      values(value: any) { values = value; return query; },
      onDuplicateKeyUpdate(value: any) { duplicateSet = value.set; return query; },
      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          db.calls.push({ kind: "insert", table: name });
          if (db.failInsertTable === name) throw new Error("injected ledger persistence failure");
          const rows = db.tables[name] ??= [];
          const match = rows.find(row => ["reference", "idempotencyKey", "operationId"].some(key => values[key] !== undefined && row[key] === values[key]) || (name.endsWith("wallets") && row.userId === values.userId) || (values.id !== undefined && row.id === values.id));
          if (match) {
            if (!duplicateSet) throw new Error("duplicate financial reference");
            Object.assign(match, duplicateSet); return [{ insertId: match.id, affectedRows: 1 }];
          }
          const row = { ...defaults[name], id: db.nextId++, createdAt: new Date(), updatedAt: new Date(), ...values };
          rows.push(row);
          return [{ insertId: row.id, affectedRows: 1 }];
        }).then(resolve, reject);
      },
    };
    return query;
  }
  update(table: any) {
    const db = this;
    return { set(values: any) { return { async where(predicate: SQL) {
      db.calls.push({ kind: "update", table: getTableName(table) });
      let affectedRows = 0;
      for (const row of db.rows(table)) if (expression(predicate, row)) {
        const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value instanceof SQL ? Number(expression(value, row)).toFixed(2) : value]));
        Object.assign(row, changes); affectedRows++;
      }
      return [{ affectedRows }];
    } }; } };
  }
}
