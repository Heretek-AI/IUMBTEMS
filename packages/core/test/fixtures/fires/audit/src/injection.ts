import type { Db } from "./db"

export function findUser(db: Db, name: string) {
  const sql = "SELECT * FROM users WHERE name = '" + name + "'"
  return db.query(sql)
}
