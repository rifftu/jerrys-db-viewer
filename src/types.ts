export type Table = { schema: string; name: string };
export type Selection = { conn: string; db: string };
export type ResultSet = { columns: string[]; rows: (string | null)[][]; affected: number };
export type FkTarget = { schema: string; table: string; column: string };
export type Connection = { name: string; dbname: string; host: string; port: number; user: string };
