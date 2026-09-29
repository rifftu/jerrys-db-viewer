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

#[derive(Default)]
struct AppState {
    clients: Mutex<HashMap<String, Arc<Client>>>,
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

async fn client(state: &AppState, name: &str) -> Result<Arc<Client>, String> {
    let mut clients = state.clients.lock().await;
    if let Some(c) = clients.get(name) {
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
        .dbname(cfg.dbname.as_deref().unwrap_or(&cfg.user))
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
    clients.insert(name.to_string(), client.clone());
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
fn list_connections() -> Result<Vec<String>, String> {
    Ok(load_config()?.into_iter().map(|c| c.name).collect())
}

#[tauri::command]
async fn list_tables(state: tauri::State<'_, AppState>, connection: String) -> Result<Vec<Table>, String> {
    let client = client(&state, &connection).await?;
    let sets = simple_query(
        &client,
        "SELECT table_schema, table_name FROM information_schema.tables \
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
         ORDER BY table_schema <> 'public', table_schema, table_name",
    )
    .await?;
    Ok(sets
        .into_iter()
        .flat_map(|s| s.rows)
        .map(|r| Table {
            schema: r[0].clone().unwrap_or_default(),
            name: r[1].clone().unwrap_or_default(),
        })
        .collect())
}

#[tauri::command]
async fn run_query(
    state: tauri::State<'_, AppState>,
    connection: String,
    sql: String,
) -> Result<Vec<ResultSet>, String> {
    let client = client(&state, &connection).await?;
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

        assert_eq!(list_connections().unwrap(), vec!["t"]);
        let state = AppState::default();
        let c = client(&state, "t").await.unwrap();
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
        assert!(Arc::ptr_eq(&c, &client(&state, "t").await.unwrap()));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![list_connections, list_tables, run_query])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
