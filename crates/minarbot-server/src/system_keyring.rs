pub fn read(service: &str, name: &str) -> keyring::Result<Option<String>> {
    match keyring::Entry::new(service, name)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn write(service: &str, name: &str, value: &str) -> keyring::Result<()> {
    keyring::Entry::new(service, name)?.set_password(value)?;
    if read(service, name)?.as_deref() != Some(value) {
        return Err(keyring::Error::NoEntry);
    }
    Ok(())
}

pub fn remove(service: &str, name: &str) -> keyring::Result<()> {
    match keyring::Entry::new(service, name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    }
}
