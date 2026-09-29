export type Selection = { conn: string; db: string };
export type ResultSet = { columns: string[]; rows: (string | null)[][]; affected: number };
export type FkTarget = { schema: string; table: string; column: string };
