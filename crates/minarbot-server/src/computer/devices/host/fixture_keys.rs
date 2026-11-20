use super::*;

pub(super) struct FixtureKeys(PathBuf);
impl FixtureKeys {
    pub(super) fn open(path: PathBuf, origin: &str) -> db::Result<Self> {
        if minarbot_launcher::rename_migration::var("MINARBOT_TEST_SERVER").as_deref() != Ok("rust")
            || !origin.starts_with("http://127.0.0.1:")
            || !valid_origin(origin, true)
        {
            return Err("Fixture keyring requires a loopback Rust test server".into());
        }
        private_metadata(&path, false)?;
        Ok(Self(path))
    }

    fn load(&self) -> Result<serde_json::Map<String, Value>> {
        if private_metadata(&self.0, false)
            .map_err(|_| keys::unavailable())?
            .len()
            > 1_048_576
        {
            return Err(keys::unavailable());
        }
        let bytes = fs::read(&self.0).map_err(|_| keys::unavailable())?;
        serde_json::from_slice(&bytes).map_err(|_| keys::unavailable())
    }

    fn update(&self, change: impl FnOnce(&mut serde_json::Map<String, Value>)) -> Result<()> {
        let mut keys = self.load()?;
        change(&mut keys);
        save(&self.0, Value::Object(keys).to_string().as_bytes(), true)
            .map_err(|_| keys::unavailable())
    }
}
impl keys::Store for FixtureKeys {
    fn read(&self, service: &str, name: &str) -> Result<Option<String>> {
        Ok(self
            .load()?
            .get(&format!("{service}/{name}"))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }
    fn write(&self, service: &str, name: &str, secret: &str) -> Result<()> {
        self.update(|keys| {
            keys.insert(format!("{service}/{name}"), secret.into());
        })
    }
    fn remove(&self, service: &str, name: &str) -> Result<()> {
        self.update(|keys| {
            keys.remove(&format!("{service}/{name}"));
        })
    }
}
