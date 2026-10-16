use std::{collections::HashMap, path::PathBuf, sync::Arc};

use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_postgres::{Client, SimpleQueryMessage};

/// Shape of `connections.toml`.
#[derive(Deserialize)]
struct ConfigFile {
    #[serde(default)]
    connection: Vec<ConnectionConfig>,
}

/// Same fields and defaults as a libpq service (`pg_service.conf`) entry.
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct ConnectionConfig {
    name: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    user: String,
    /// Defaults to `user`, like libpq.
    dbname: Option<String>,
    /// Empty means none.
    #[serde(default)]
    password: String,
    #[serde(default)]
    sslmode: SslMode,
}

impl ConnectionConfig {
    fn default_dbname(&self) -> &str {
        self.dbname.as_deref().unwrap_or(&self.user)
    }
}

fn default_host() -> String {
    "localhost".into()
}

fn default_port() -> u16 {
    5432
}

/// libpq semantics: `prefer`/`require` encrypt without verifying the server
/// certificate; `verify-ca` checks the chain, `verify-full` also the hostname.
#[derive(Deserialize, Clone, Copy, Default, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// Single-column foreign keys of one database: (table oid, column number) -> referenced column.
type FkMap = HashMap<(u32, i16), FkTarget>;

#[derive(Default)]
struct AppState {
    /// Keyed by (connection name, database).
    clients: Mutex<HashMap<(String, String), Arc<Client>>>,
    /// Keyed by (connection name, database). Refreshed whenever the sidebar lists that
    /// database's tables; kept across reconnects, dropped when the app exits.
    fks: std::sync::Mutex<HashMap<(String, String), Arc<FkMap>>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
struct FkTarget {
    schema: String,
    table: String,
    column: String,
}

#[derive(Serialize, Debug, PartialEq)]
struct Connection {
    name: String,
    /// The configured `dbname` (or `user`), used until another database is picked.
    dbname: String,
    /// Shown in the edit panel's review header; the password is never sent to the UI.
    host: String,
    port: u16,
    user: String,
}

#[derive(Serialize)]
struct Table {
    schema: String,
    name: String,
}

#[derive(Serialize, Default, Debug)]
struct ResultSet {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    affected: u64,
}

fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("DB_VIEWER_CONFIG") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config/jerrys-db-viewer/connections.toml")
}

/// Re-read on every call so edits to the config file apply without restarting.
fn load_config() -> Result<Vec<ConnectionConfig>, String> {
    let path = config_path();
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read {}: {e}\nSee connections.example.toml.", path.display()))?;
    let cfg: ConfigFile = toml::from_str(&text).map_err(|e| format!("Invalid {}: {e}", path.display()))?;
    Ok(cfg.connection)
}

async fn client(state: &AppState, name: &str, database: &str) -> Result<Arc<Client>, String> {
    let key = (name.to_string(), database.to_string());
    let mut clients = state.clients.lock().await;
    if let Some(c) = clients.get(&key) {
        if !c.is_closed() {
            return Ok(c.clone());
        }
    }

    let cfg = load_config()?
        .into_iter()
        .find(|c| c.name == name)
        .ok_or_else(|| format!("Unknown connection: {name}"))?;
    let mut pg = tokio_postgres::Config::new();
    pg.host(&cfg.host)
        .port(cfg.port)
        .user(&cfg.user)
        .dbname(database)
        .application_name("jerrys-db-viewer")
        .ssl_mode(match cfg.sslmode {
            SslMode::Disable => tokio_postgres::config::SslMode::Disable,
            SslMode::Prefer => tokio_postgres::config::SslMode::Prefer,
            _ => tokio_postgres::config::SslMode::Require,
        });
    if !cfg.password.is_empty() {
        pg.password(&cfg.password);
    }
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(matches!(cfg.sslmode, SslMode::Prefer | SslMode::Require))
        .danger_accept_invalid_hostnames(cfg.sslmode != SslMode::VerifyFull)
        .build()
        .map_err(|e| e.to_string())?;

    let (client, connection) = pg.connect(MakeTlsConnector::new(tls)).await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("connection error: {e}");
        }
    });

    let client = Arc::new(client);
    clients.insert(key, client.clone());
    Ok(client)
}

/// Runs SQL via the simple query protocol, so every value comes back as text
/// and no per-type decoding is needed. Returns one result set per statement.
async fn simple_query(client: &Client, sql: &str) -> Result<Vec<ResultSet>, String> {
    let mut sets = Vec::new();
    let mut current: Option<ResultSet> = None;
    for msg in client.simple_query(sql).await.map_err(format_db_error)? {
        match msg {
            SimpleQueryMessage::RowDescription(cols) => {
                current = Some(ResultSet {
                    columns: cols.iter().map(|c| c.name().to_string()).collect(),
                    ..Default::default()
                });
            }
            SimpleQueryMessage::Row(row) => {
                let set = current.get_or_insert_with(Default::default);
                set.rows.push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
            }
            SimpleQueryMessage::CommandComplete(n) => {
                let mut set = current.take().unwrap_or_default();
                set.affected = n;
                sets.push(set);
            }
            _ => {}
        }
    }
    Ok(sets)
}

fn format_db_error(e: tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => {
            let mut s = format!("{}: {}", db.severity(), db.message());
            if let Some(d) = db.detail() {
                s.push_str(&format!("\nDETAIL: {d}"));
            }
            if let Some(h) = db.hint() {
                s.push_str(&format!("\nHINT: {h}"));
            }
            s
        }
        None => e.to_string(),
    }
}

#[tauri::command]
fn list_connections() -> Result<Vec<Connection>, String> {
    Ok(load_config()?
        .iter()
        .map(|c| Connection {
            name: c.name.clone(),
            dbname: c.default_dbname().to_string(),
            host: c.host.clone(),
            port: c.port,
            user: c.user.clone(),
        })
        .collect())
}

/// Lists databases on the server, queried through the currently selected one.
#[tauri::command]
async fn list_databases(
    state: tauri::State<'_, AppState>,
    connection: String,
    database: String,
) -> Result<Vec<String>, String> {
    let client = client(&state, &connection, &database).await?;
    let sets = simple_query(
        &client,
        "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
    )
    .await?;
    Ok(sets.into_iter().flat_map(|s| s.rows).filter_map(|mut r| r.remove(0)).collect())
}

const FK_SQL: &str = "SELECT c.conrelid, c.conkey[1], n.nspname, t.relname, a.attname \
     FROM pg_constraint c \
     JOIN pg_class t ON t.oid = c.confrelid \
     JOIN pg_namespace n ON n.oid = t.relnamespace \
     JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = c.confkey[1] \
     WHERE c.contype = 'f' AND cardinality(c.conkey) = 1";

fn parse_fks(sets: Vec<ResultSet>) -> FkMap {
    let mut map = FkMap::new();
    for r in sets.into_iter().flat_map(|s| s.rows) {
        let (Some(Some(rel)), Some(Some(att))) = (r[0].as_ref().map(|v| v.parse().ok()), r[1].as_ref().map(|v| v.parse().ok())) else {
            continue;
        };
        let text = |i: usize| r[i].clone().unwrap_or_default();
        // A column with several FKs keeps the first.
        map.entry((rel, att)).or_insert(FkTarget { schema: text(2), table: text(3), column: text(4) });
    }
    map
}

/// Lists tables and, pipelined on the same connection, refreshes the database's FK cache.
async fn tables(state: &AppState, connection: &str, database: &str) -> Result<Vec<Table>, String> {
    let client = client(state, connection, database).await?;
    let (tables, fks) = tokio::join!(
        simple_query(
            &client,
            "SELECT table_schema, table_name FROM information_schema.tables \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema <> 'public', table_schema, table_name",
        ),
        simple_query(&client, FK_SQL),
    );
    // An FK lookup failure just means no links; keep any previous cache.
    if let Ok(fks) = fks {
        state
            .fks
            .lock()
            .unwrap()
            .insert((connection.to_string(), database.to_string()), Arc::new(parse_fks(fks)));
    }
    Ok(tables?
        .into_iter()
        .flat_map(|s| s.rows)
        .map(|r| Table {
            schema: r[0].clone().unwrap_or_default(),
            name: r[1].clone().unwrap_or_default(),
        })
        .collect())
}

#[tauri::command]
async fn list_tables(
    state: tauri::State<'_, AppState>,
    connection: String,
    database: String,
) -> Result<Vec<Table>, String> {
    tables(&state, &connection, &database).await
}

/// For each output column of `sql`, the FK it reads from (if any). Uses a server-side
/// describe (parse only, nothing is executed) plus the cached FK map. `None` when the SQL
/// can't be described (e.g. several statements) or the database's FKs aren't cached.
async fn describe(state: &AppState, connection: &str, database: &str, sql: &str) -> Option<Vec<Option<FkTarget>>> {
    let fks = state.fks.lock().unwrap().get(&(connection.to_string(), database.to_string())).cloned()?;
    let client = client(state, connection, database).await.ok()?;
    let stmt = client.prepare(sql).await.ok()?;
    Some(
        stmt.columns()
            .iter()
            .map(|c| fks.get(&(c.table_oid()?, c.column_id()?)).cloned())
            .collect(),
    )
}

#[tauri::command]
async fn describe_columns(
    state: tauri::State<'_, AppState>,
    connection: String,
    database: String,
    sql: String,
) -> Result<Option<Vec<Option<FkTarget>>>, String> {
    Ok(describe(&state, &connection, &database, &sql).await)
}

fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn quote_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// (schema, table) of every relation scan in an EXPLAIN (VERBOSE, FORMAT JSON) plan, in plan
/// order; a table scanned twice (self-join) appears twice.
fn plan_relations(v: &serde_json::Value, out: &mut Vec<(String, String)>) {
    match v {
        serde_json::Value::Object(m) => {
            if let (Some(schema), Some(rel)) =
                (m.get("Schema").and_then(|x| x.as_str()), m.get("Relation Name").and_then(|x| x.as_str()))
            {
                out.push((schema.to_string(), rel.to_string()));
            }
            m.values().for_each(|x| plan_relations(x, out));
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| plan_relations(x, out)),
        _ => {}
    }
}

/// Plain-text metadata for every table `sql` touches. Tables come from EXPLAIN (planned,
/// not executed), so joins, subqueries and UPDATE/DELETE targets count; views show as
/// their underlying tables. Two round trips: the EXPLAIN, then one batched catalog query.
async fn tables_info_text(state: &AppState, connection: &str, database: &str, sql: &str) -> Result<String, String> {
    let client = client(state, connection, database).await?;
    let plan = simple_query(&client, &format!("EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) {sql}")).await?;
    let json: String = plan.into_iter().flat_map(|s| s.rows).filter_map(|mut r| r.remove(0)).collect();
    let plan: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let mut rels = Vec::new();
    plan_relations(&plan, &mut rels);
    let mut seen = Vec::new();
    rels.retain(|r| if seen.contains(r) { false } else { seen.push(r.clone()); true });
    if rels.is_empty() {
        return Ok("No tables referenced.".into());
    }
    let arr = format!(
        "ARRAY[{}]::regclass[]",
        rels.iter()
            .map(|(s, t)| quote_literal(&format!("{}.{}", quote_ident(s), quote_ident(t))))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let sets = simple_query(
        &client,
        &format!(
            "SELECT c.oid, n.nspname, c.relname, c.reltuples::bigint, pg_size_pretty(pg_total_relation_size(c.oid)), \
                    obj_description(c.oid, 'pg_class') \
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = ANY ({arr}); \
             SELECT a.attrelid, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid) \
               FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
              WHERE a.attrelid = ANY ({arr}) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attrelid, a.attnum; \
             SELECT conrelid, conname, pg_get_constraintdef(oid) FROM pg_constraint \
              WHERE conrelid = ANY ({arr}) ORDER BY conrelid, contype, conname; \
             SELECT indrelid, pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid = ANY ({arr}) ORDER BY indrelid, indexrelid"
        ),
    )
    .await?;
    let [tables, cols, cons, idx]: [Vec<Vec<Option<String>>>; 4] =
        sets.into_iter().map(|s| s.rows).collect::<Vec<_>>().try_into().map_err(|_| "unexpected catalog result")?;
    let v = |r: &Vec<Option<String>>, i: usize| r[i].clone().unwrap_or_default();

    let mut out = String::new();
    // Plan order, which follows the query.
    for (schema, table) in &rels {
        let Some(t) = tables.iter().find(|t| v(t, 1) == *schema && v(t, 2) == *table) else { continue };
        let oid = v(t, 0);
        let rows = match v(t, 3).as_str() {
            "-1" => "?".to_string(),
            n => n.to_string(),
        };
        out.push_str(&format!("{schema}.{table}  (~{rows} rows, {})\n", v(t, 4)));
        if let Some(c) = &t[5] {
            out.push_str(&format!("  -- {c}\n"));
        }
        out.push_str("columns:\n");
        for c in cols.iter().filter(|c| v(c, 0) == oid) {
            let not_null = if v(c, 3) == "t" { "  not null" } else { "" };
            let default = c[4].as_ref().map(|d| format!("  default {d}")).unwrap_or_default();
            out.push_str(&format!("  {}  {}{not_null}{default}\n", v(c, 1), v(c, 2)));
        }
        let cs: Vec<_> = cons.iter().filter(|c| v(c, 0) == oid).collect();
        if !cs.is_empty() {
            out.push_str("constraints:\n");
            cs.iter().for_each(|c| out.push_str(&format!("  {}  {}\n", v(c, 1), v(c, 2))));
        }
        let is: Vec<_> = idx.iter().filter(|i| v(i, 0) == oid).collect();
        if !is.is_empty() {
            out.push_str("indexes:\n");
            is.iter().for_each(|i| out.push_str(&format!("  {}\n", v(i, 1))));
        }
        out.push('\n');
    }
    Ok(out)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ColumnMeta {
    name: String,
    /// pg_type.typcategory (S string, B bool, N numeric, A array, D date/time, ...).
    category: String,
    typname: String,
    /// format_type(), e.g. "character varying(255)", for annotating generated SQL.
    display_type: String,
    not_null: bool,
    has_default: bool,
    generated: bool,
    identity: bool,
    #[serde(skip)]
    attnum: i16,
}

#[derive(Serialize, Debug)]
struct TableMeta {
    columns: Vec<ColumnMeta>,
    /// Column names of the primary key (first) and plain unique indexes (no predicate/expressions).
    keys: Vec<Vec<String>>,
    #[serde(skip)]
    oid: u32,
}

/// Columns and unique keys of one table, for generating row-level SQL. One round trip.
async fn table_meta_of(state: &AppState, connection: &str, database: &str, schema: &str, table: &str) -> Result<TableMeta, String> {
    let client = client(state, connection, database).await?;
    let reg = format!("{}::regclass", quote_literal(&format!("{}.{}", quote_ident(schema), quote_ident(table))));
    let sets = simple_query(
        &client,
        &format!(
            "SELECT a.attname, t.typcategory, t.typname, a.attnotnull, a.atthasdef, a.attgenerated <> '', a.attidentity <> '', \
                    a.attrelid, a.attnum, format_type(a.atttypid, a.atttypmod) \
               FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid \
              WHERE a.attrelid = {reg} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum; \
             SELECT (SELECT json_agg(a.attname ORDER BY k.o) FROM unnest(i.indkey) WITH ORDINALITY k(n, o) \
                       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n) \
               FROM pg_index i \
              WHERE i.indrelid = {reg} AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL \
              ORDER BY i.indisprimary DESC, i.indexrelid"
        ),
    )
    .await?;
    let [cols, keys]: [Vec<Vec<Option<String>>>; 2] =
        sets.into_iter().map(|s| s.rows).collect::<Vec<_>>().try_into().map_err(|_| "unexpected catalog result")?;
    let text = |r: &Vec<Option<String>>, i: usize| r[i].clone().unwrap_or_default();
    let flag = |r: &Vec<Option<String>>, i: usize| r[i].as_deref() == Some("t");
    Ok(TableMeta {
        columns: cols
            .iter()
            .map(|r| ColumnMeta {
                name: text(r, 0),
                category: text(r, 1),
                typname: text(r, 2),
                display_type: text(r, 9),
                not_null: flag(r, 3),
                has_default: flag(r, 4),
                generated: flag(r, 5),
                identity: flag(r, 6),
                attnum: text(r, 8).parse().unwrap_or(0),
            })
            .collect(),
        oid: cols.first().and_then(|r| text(r, 7).parse().ok()).unwrap_or(0),
        keys: keys.iter().filter_map(|r| serde_json::from_str(r[0].as_deref()?).ok()).collect(),
    })
}

/// What the edit panel's row shortcuts need for a tab's last query.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct EditContext {
    schema: String,
    table: String,
    #[serde(flatten)]
    meta: TableMeta,
    /// Per result column: the table column it reads directly (so aliases still map), or null
    /// for anything else (expressions, aggregates).
    result_columns: Vec<Option<String>>,
}

/// Decides whether row shortcuts can target `sql`'s results, and returns what generating the
/// SQL needs. Allowed: one SELECT over exactly one table scan (WHERE / ORDER BY / LIMIT /
/// column lists are fine); joins, self-joins, subqueries on other tables and views are not.
/// Two round trips: describe + EXPLAIN pipelined (neither executes the query), then the catalog.
async fn edit_context_of(state: &AppState, connection: &str, database: &str, sql: &str) -> Result<EditContext, String> {
    let client = client(state, connection, database).await?;
    let explain = format!("EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) {sql}");
    let (stmt, plan) = tokio::join!(client.prepare(sql), simple_query(&client, &explain));
    let stmt = stmt.map_err(|_| "Only a single SELECT statement is supported".to_string())?;
    let plan = plan.map_err(|_| "Only a single SELECT statement is supported".to_string())?;
    let json: String = plan.into_iter().flat_map(|s| s.rows).filter_map(|mut r| r.remove(0)).collect();
    let mut rels = Vec::new();
    plan_relations(&serde_json::from_str(&json).map_err(|e| e.to_string())?, &mut rels);
    let [(schema, table)]: [(String, String); 1] = rels
        .try_into()
        .map_err(|_| "Only queries reading exactly one table (no joins or subqueries) are supported".to_string())?;
    let meta = table_meta_of(state, connection, database, &schema, &table).await?;
    let result_columns = stmt
        .columns()
        .iter()
        .map(|c| {
            let (oid, attnum) = (c.table_oid()?, c.column_id()?);
            (oid == meta.oid).then(|| meta.columns.iter().find(|m| m.attnum == attnum).map(|m| m.name.clone()))?
        })
        .collect::<Vec<_>>();
    // e.g. a view (its columns aren't the base table's) or only aggregates: not a view of rows.
    if result_columns.iter().all(Option::is_none) {
        return Err(format!("No result column comes directly from {schema}.{table}"));
    }
    Ok(EditContext { schema, table, meta, result_columns })
}

#[tauri::command]
async fn edit_context(
    state: tauri::State<'_, AppState>,
    connection: String,
    database: String,
    sql: String,
) -> Result<EditContext, String> {
    edit_context_of(&state, &connection, &database, &sql).await
}

/// Plain-text FK relations of the single table `sql` reads: parents (tables it references) and
/// children (tables referencing it). Queries reading several distinct tables are rejected (a
/// self-join is one table). Two round trips: the EXPLAIN (planned, not executed), then one batched
/// catalog query. Per-partition clones of FKs (conparentid <> 0) are skipped so each FK shows once.
async fn relations_text(state: &AppState, connection: &str, database: &str, sql: &str) -> Result<String, String> {
    let client = client(state, connection, database).await?;
    let plan = simple_query(&client, &format!("EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) {sql}")).await?;
    let json: String = plan.into_iter().flat_map(|s| s.rows).filter_map(|mut r| r.remove(0)).collect();
    let mut rels = Vec::new();
    plan_relations(&serde_json::from_str(&json).map_err(|e| e.to_string())?, &mut rels);
    rels.dedup();
    let mut distinct = rels.clone();
    distinct.sort();
    distinct.dedup();
    let (schema, table) = match distinct.as_slice() {
        [] => return Ok("No tables referenced.".into()),
        [one] => one.clone(),
        _ => return Err("Relations are only shown for queries reading a single table.".into()),
    };
    let reg = format!("{}::regclass", quote_literal(&format!("{}.{}", quote_ident(&schema), quote_ident(&table))));
    // Column names of a constraint side, in key order, as JSON (safe for odd names).
    let cols = |rel: &str, key: &str| {
        format!(
            "(SELECT json_agg(a.attname ORDER BY k.o) FROM unnest(c.{key}) WITH ORDINALITY k(n, o) \
               JOIN pg_attribute a ON a.attrelid = c.{rel} AND a.attnum = k.n)"
        )
    };
    let sets = simple_query(
        &client,
        &format!(
            "SELECT c.conname, n.nspname, t.relname, {}, {}, c.confdeltype \
               FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid JOIN pg_namespace n ON n.oid = t.relnamespace \
              WHERE c.contype = 'f' AND c.conparentid = 0 AND c.conrelid = {reg} ORDER BY 2, 3, 1; \
             SELECT c.conname, n.nspname, t.relname, {}, {}, c.confdeltype \
               FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace \
              WHERE c.contype = 'f' AND c.conparentid = 0 AND c.confrelid = {reg} ORDER BY 2, 3, 1",
            cols("conrelid", "conkey"),
            cols("confrelid", "confkey"),
            cols("conrelid", "conkey"),
            cols("confrelid", "confkey"),
        ),
    )
    .await?;
    let [parents, children]: [Vec<Vec<Option<String>>>; 2] =
        sets.into_iter().map(|s| s.rows).collect::<Vec<_>>().try_into().map_err(|_| "unexpected catalog result")?;
    let v = |r: &Vec<Option<String>>, i: usize| r[i].clone().unwrap_or_default();
    let list = |r: &Vec<Option<String>>, i: usize| -> String {
        serde_json::from_str::<Vec<String>>(r[i].as_deref().unwrap_or("[]")).unwrap_or_default().join(", ")
    };
    // confdeltype: a = no action (default), r = restrict, c = cascade, n = set null, d = set default.
    let on_delete = |r: &Vec<Option<String>>| match v(r, 5).as_str() {
        "r" => ", on delete restrict",
        "c" => ", on delete cascade",
        "n" => ", on delete set null",
        "d" => ", on delete set default",
        _ => "",
    };

    // public tables by bare name; other schemas keep their prefix so same-named tables stay distinct.
    let name = |r: &Vec<Option<String>>| match v(r, 1).as_str() {
        "public" => v(r, 2),
        s => format!("{s}.{}", v(r, 2)),
    };
    let mut out = format!("{schema}.{table}\n\nparents:\n");
    if parents.is_empty() {
        out.push_str("  (none)\n");
    }
    for r in &parents {
        out.push_str(&format!("  {} → {}[{}]   [{}{}]\n", list(r, 3), name(r), list(r, 4), v(r, 0), on_delete(r)));
    }
    out.push_str("\nchildren:\n");
    if children.is_empty() {
        out.push_str("  (none)\n");
    }
    for r in &children {
        out.push_str(&format!("  {}[{}] → {}   [{}{}]\n", name(r), list(r, 3), list(r, 4), v(r, 0), on_delete(r)));
    }
    Ok(out)
}

#[tauri::command]
async fn table_relations(
    state: tauri::State<'_, AppState>,
    connection: String,
    database: String,
    sql: String,
) -> Result<String, String> {
    relations_text(&state, &connection, &database, &sql).await
}

#[tauri::command]
async fn tables_info(
    state: tauri::State<'_, AppState>,
    connection: String,
    database: String,
    sql: String,
) -> Result<String, String> {
    tables_info_text(&state, &connection, &database, &sql).await
}

#[tauri::command]
async fn run_query(
    state: tauri::State<'_, AppState>,
    connection: String,
    database: String,
    sql: String,
) -> Result<Vec<ResultSet>, String> {
    let client = client(&state, &connection, &database).await?;
    simple_query(&client, &sql).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a scratch database on localhost with user `postgres`, password `test`,
    /// listening on `DB_VIEWER_TEST_PORT` (see LESSONS.md).
    #[tokio::test]
    async fn query_roundtrip() {
        let Ok(port) = std::env::var("DB_VIEWER_TEST_PORT") else {
            eprintln!("DB_VIEWER_TEST_PORT not set, skipping");
            return;
        };
        let path = std::env::temp_dir().join("db-viewer-test-connections.toml");
        std::fs::write(
            &path,
            format!("[[connection]]\nname = \"t\"\nport = {port}\nuser = \"postgres\"\npassword = \"test\"\nsslmode = \"disable\"\n"),
        )
        .unwrap();
        std::env::set_var("DB_VIEWER_CONFIG", &path);

        // dbname defaults to user.
        assert_eq!(
            list_connections().unwrap(),
            vec![Connection {
                name: "t".into(),
                dbname: "postgres".into(),
                host: "localhost".into(),
                port: port.parse().unwrap(),
                user: "postgres".into()
            }]
        );
        let state = AppState::default();
        let c = client(&state, "t", "postgres").await.unwrap();
        let sets = simple_query(
            &c,
            "DROP TABLE IF EXISTS dbv_t; CREATE TABLE dbv_t (id int, name text); \
             INSERT INTO dbv_t VALUES (1, 'a'), (2, NULL); SELECT * FROM dbv_t ORDER BY id; \
             SELECT 1 WHERE false",
        )
        .await
        .unwrap();
        assert_eq!(sets[2].affected, 2);
        assert_eq!(sets[3].columns, vec!["id", "name"]);
        assert_eq!(sets[3].rows, vec![vec![Some("1".into()), Some("a".into())], vec![Some("2".into()), None]]);
        // Empty result still reports its columns.
        assert_eq!(sets[4].columns, vec!["?column?"]);
        assert!(sets[4].rows.is_empty());

        let err = simple_query(&c, "SELECT * FROM nope").await.unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        // Same client is reused after an error.
        assert!(Arc::ptr_eq(&c, &client(&state, "t", "postgres").await.unwrap()));

        // FK links: cache is filled by listing tables, then describe maps result columns to it.
        simple_query(
            &c,
            "DROP TABLE IF EXISTS dbv_child, dbv_parent CASCADE; DROP TYPE IF EXISTS dbv_mood; \
             CREATE TYPE dbv_mood AS ENUM ('ok'); \
             CREATE TABLE dbv_parent (pid int PRIMARY KEY, label text); \
             CREATE TABLE dbv_child (id int, parent_id int REFERENCES dbv_parent (pid), mood dbv_mood)",
        )
        .await
        .unwrap();
        assert_eq!(describe(&state, "t", "postgres", "SELECT * FROM dbv_child").await, None, "no cache yet");
        tables(&state, "t", "postgres").await.unwrap();
        let parent = Some(FkTarget { schema: "public".into(), table: "dbv_parent".into(), column: "pid".into() });
        assert_eq!(
            describe(&state, "t", "postgres", "SELECT * FROM dbv_child").await,
            Some(vec![None, parent.clone(), None]),
            "custom enum column still describes"
        );
        assert_eq!(
            describe(&state, "t", "postgres", "SELECT ch.parent_id AS p, 1 AS one FROM dbv_child ch").await,
            Some(vec![parent, None])
        );
        assert_eq!(describe(&state, "t", "postgres", "SELECT 1; SELECT 2").await, None);

        // Table metadata for every table a query touches (joins and UPDATE targets included).
        let info = tables_info_text(&state, "t", "postgres", "SELECT ch.id FROM dbv_child ch JOIN dbv_parent p ON p.pid = ch.parent_id")
            .await
            .unwrap();
        assert!(info.contains("public.dbv_child") && info.contains("public.dbv_parent"), "{info}");
        assert!(info.contains("parent_id  integer"), "{info}");
        assert!(info.contains("FOREIGN KEY (parent_id) REFERENCES dbv_parent(pid)"), "{info}");
        assert!(info.contains("CREATE UNIQUE INDEX dbv_parent_pkey"), "{info}");
        let info = tables_info_text(&state, "t", "postgres", "UPDATE dbv_parent SET label = 'x' WHERE pid = 1").await.unwrap();

        // Relations: single-table queries only (a self-join is one table); both directions.
        let r = relations_text(&state, "t", "postgres", "SELECT * FROM dbv_parent WHERE pid > 0 ORDER BY pid LIMIT 5").await.unwrap();
        assert!(r.starts_with("public.dbv_parent"), "{r}");
        assert!(r.contains("children:\n  dbv_child[parent_id] → pid   [dbv_child_parent_id_fkey]"), "{r}");
        assert!(r.contains("parents:\n  (none)"), "{r}");
        let r = relations_text(&state, "t", "postgres", "SELECT a.* FROM dbv_child a JOIN dbv_child b ON a.id = b.id").await.unwrap();
        assert!(r.contains("parent_id → dbv_parent[pid]   [dbv_child_parent_id_fkey]"), "{r}");
        assert!(relations_text(&state, "t", "postgres", "SELECT * FROM dbv_child c JOIN dbv_parent p ON p.pid = c.parent_id").await.is_err());
        assert_eq!(relations_text(&state, "t", "postgres", "SELECT 1").await.unwrap(), "No tables referenced.");
        // ON DELETE actions are shown; a partitioned child's FK appears once, not once per partition.
        simple_query(
            &c,
            "DROP TABLE IF EXISTS dbv_grand, dbv_part; \
             CREATE TABLE dbv_grand (id int, p int REFERENCES dbv_parent (pid) ON DELETE CASCADE); \
             CREATE TABLE dbv_part (id int, p int REFERENCES dbv_parent (pid)) PARTITION BY RANGE (id); \
             CREATE TABLE dbv_part_1 PARTITION OF dbv_part FOR VALUES FROM (0) TO (10); \
             CREATE TABLE dbv_part_2 PARTITION OF dbv_part FOR VALUES FROM (10) TO (20)",
        )
        .await
        .unwrap();
        let r = relations_text(&state, "t", "postgres", "SELECT * FROM dbv_parent").await.unwrap();
        assert!(r.contains("dbv_grand[p] → pid   [dbv_grand_p_fkey, on delete cascade]"), "{r}");
        assert!(r.contains("dbv_part[p] → pid"), "{r}");
        // Non-public schemas keep their prefix.
        simple_query(&c, "CREATE SCHEMA IF NOT EXISTS dbv_s; DROP TABLE IF EXISTS dbv_s.kid; \
                          CREATE TABLE dbv_s.kid (id int, p int REFERENCES dbv_parent (pid))")
            .await
            .unwrap();
        let r = relations_text(&state, "t", "postgres", "SELECT * FROM dbv_parent").await.unwrap();
        assert!(r.contains("dbv_s.kid[p] → pid   [kid_p_fkey]"), "{r}");
        assert!(!r.contains("dbv_part_1") && !r.contains("dbv_part_2"), "{r}");        assert!(info.starts_with("public.dbv_parent"), "{info}");
        assert_eq!(tables_info_text(&state, "t", "postgres", "SELECT 1").await.unwrap(), "No tables referenced.");
        assert!(tables_info_text(&state, "t", "postgres", "SELECT 1; SELECT 2").await.is_err());

        // Row-SQL metadata: columns with flags, primary key first, plain unique indexes only.
        simple_query(
            &c,
            "DROP TABLE IF EXISTS dbv_meta CASCADE; \
             CREATE TABLE dbv_meta (id serial PRIMARY KEY, \"we ird\" text NOT NULL, a int, b int, \
               up text GENERATED ALWAYS AS (upper(\"we ird\")) STORED, ok boolean NOT NULL, \
               UNIQUE (a, b)); \
             CREATE UNIQUE INDEX dbv_meta_partial ON dbv_meta (a) WHERE a > 0",
        )
        .await
        .unwrap();
        let m = table_meta_of(&state, "t", "postgres", "public", "dbv_meta").await.unwrap();
        assert_eq!(m.keys, vec![vec!["id".to_string()], vec!["a".to_string(), "b".to_string()]]);
        let names: Vec<_> = m.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["id", "we ird", "a", "b", "up", "ok"]);
        assert!(m.columns[0].has_default && m.columns[0].not_null && m.columns[0].category == "N");
        assert!(m.columns[4].generated && !m.columns[2].not_null);
        assert_eq!((m.columns[5].category.as_str(), m.columns[5].typname.as_str()), ("B", "bool"));
        assert_eq!((m.columns[0].display_type.as_str(), m.columns[5].display_type.as_str()), ("integer", "boolean"));

        // Edit context: hand-written single-table queries are fine; aliases map back to columns.
        let ctx = edit_context_of(&state, "t", "postgres", "SELECT * FROM dbv_meta WHERE a > 0 ORDER BY id DESC LIMIT 5").await.unwrap();
        assert_eq!((ctx.schema.as_str(), ctx.table.as_str()), ("public", "dbv_meta"));
        assert_eq!(ctx.result_columns.len(), 6);
        assert_eq!(ctx.meta.keys[0], vec!["id".to_string()]);
        let ctx = edit_context_of(&state, "t", "postgres", "SELECT \"we ird\" AS w, id, a + 1 AS a1 FROM dbv_meta m WHERE m.ok").await.unwrap();
        assert_eq!(ctx.result_columns, vec![Some("we ird".to_string()), Some("id".to_string()), None]);
        // Not allowed: joins, self-joins, subqueries on other tables, no table, several statements.
        for bad in [
            "SELECT m.* FROM dbv_meta m JOIN dbv_parent p ON p.pid = m.a",
            "SELECT x.* FROM dbv_meta x JOIN dbv_meta y ON x.id = y.a",
            "SELECT * FROM dbv_meta WHERE a IN (SELECT pid FROM dbv_parent)",
            "SELECT 1",
            "SELECT 1; SELECT 2",
        ] {
            assert!(edit_context_of(&state, "t", "postgres", bad).await.is_err(), "{bad}");
        }
        // A view reads its base table, but its columns don't come from that table directly; same for
        // aggregates. Those aren't row views, so no shortcuts at all.
        simple_query(&c, "CREATE OR REPLACE VIEW dbv_meta_v AS SELECT * FROM dbv_meta").await.unwrap();
        assert!(edit_context_of(&state, "t", "postgres", "SELECT * FROM dbv_meta_v").await.is_err());
        assert!(edit_context_of(&state, "t", "postgres", "SELECT count(*) FROM dbv_meta").await.is_err());

        // Picking another database opens a separate client connected to it.
        simple_query(&c, "DROP DATABASE IF EXISTS dbv_other").await.unwrap();
        simple_query(&c, "CREATE DATABASE dbv_other").await.unwrap();
        let other = client(&state, "t", "dbv_other").await.unwrap();
        assert!(!Arc::ptr_eq(&c, &other));
        let sets = simple_query(&other, "SELECT current_database()").await.unwrap();
        assert_eq!(sets[0].rows, vec![vec![Some("dbv_other".into())]]);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![list_connections, list_databases, list_tables, describe_columns, tables_info, table_relations, edit_context, run_query])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
