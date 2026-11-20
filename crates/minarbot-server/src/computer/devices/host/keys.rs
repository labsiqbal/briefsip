use super::super::{public_key, Result, B64};
use crate::web::Failure;
use base64::Engine;
use curve25519_dalek::montgomery::MontgomeryPoint;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::Value;
use subtle::ConstantTimeEq;

const ED25519_PRIVATE: &[u8] = &[
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];
const X25519_PRIVATE: &[u8] = &[
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
];

pub(super) fn unavailable() -> Failure {
    Failure::new(503, "device_key_unavailable", "Device key is unavailable.")
}
pub(super) fn entropy<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::getrandom(&mut bytes).map_err(|_| Failure::storage())?;
    Ok(bytes)
}
pub(super) trait Store: Send + Sync {
    fn read(&self, service: &str, name: &str) -> Result<Option<String>>;
    fn write(&self, service: &str, name: &str, secret: &str) -> Result<()>;
    fn remove(&self, service: &str, name: &str) -> Result<()>;
}
pub(super) struct System;
impl Store for System {
    fn read(&self, service: &str, name: &str) -> Result<Option<String>> {
        crate::rename_migration::read_system_key(service, name).map_err(|_| unavailable())
    }
    fn write(&self, service: &str, name: &str, secret: &str) -> Result<()> {
        crate::rename_migration::write_system_key(service, name, secret).map_err(|_| unavailable())
    }
    fn remove(&self, service: &str, name: &str) -> Result<()> {
        crate::rename_migration::remove_system_key(service, name).map_err(|_| unavailable())
    }
}
pub(super) enum Private {
    Signing(Ed25519KeyPair),
    Encryption([u8; 32]),
}
impl Private {
    pub fn open(
        store: &dyn Store,
        service: &str,
        name: &str,
        encryption: bool,
        create: bool,
    ) -> Result<Self> {
        let stored = match store.read(service, name)? {
            Some(value) => value,
            None if create => {
                let prefix = if encryption {
                    X25519_PRIVATE
                } else {
                    ED25519_PRIVATE
                };
                let bytes = [prefix, &entropy::<32>()?].concat();
                let value = B64.encode(bytes);
                store.write(service, name, &value)?;
                if store.read(service, name)?.as_deref() != Some(&value) {
                    return Err(unavailable());
                }
                value
            }
            _ => return Err(unavailable()),
        };
        let bytes = B64.decode(stored).map_err(|_| unavailable())?;
        if encryption {
            let seed = bytes
                .strip_prefix(X25519_PRIVATE)
                .and_then(|seed| seed.try_into().ok())
                .ok_or_else(unavailable)?;
            Ok(Self::Encryption(seed))
        } else {
            Ok(Self::Signing(
                Ed25519KeyPair::from_pkcs8_maybe_unchecked(&bytes).map_err(|_| unavailable())?,
            ))
        }
    }
    pub fn public(&self) -> Vec<u8> {
        let mut der = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0,
        ];
        match self {
            Self::Signing(key) => der.extend_from_slice(key.public_key().as_ref()),
            Self::Encryption(seed) => {
                der[8] = 0x6e;
                der.extend(MontgomeryPoint::mul_base_clamped(*seed).to_bytes());
            }
        }
        der
    }
    pub fn sign(&self, value: &Value) -> Result<String> {
        match self {
            Self::Signing(key) => Ok(B64.encode(key.sign(value.to_string().as_bytes()).as_ref())),
            Self::Encryption(_) => Err(unavailable()),
        }
    }
    pub fn agree(&self, peer: &Value) -> Result<[u8; 32]> {
        let Self::Encryption(seed) = self else {
            return Err(unavailable());
        };
        let raw = public_key(peer, "x25519")?;
        let point = MontgomeryPoint(raw[12..].try_into().map_err(|_| unavailable())?);
        let result = point.mul_clamped(*seed).to_bytes();
        if bool::from(result.ct_eq(&[0; 32])) {
            return Err(unavailable());
        }
        Ok(result)
    }
}

pub(super) fn stage(store: &dyn Store, service: &str, name: &str, secret: &str) -> Result<()> {
    match store.read(service, name).map_err(|_| unavailable())? {
        Some(previous) if previous != secret => {
            return Err(Failure::new(
                409,
                "secret_conflict",
                "Keyring reference is already in use.",
            ));
        }
        Some(_) => {}
        None => store
            .write(service, name, secret)
            .map_err(|_| unavailable())?,
    }
    if store
        .read(service, name)
        .map_err(|_| unavailable())?
        .as_deref()
        != Some(secret)
    {
        return Err(unavailable());
    }
    Ok(())
}

pub(super) fn remove_verified(store: &dyn Store, service: &str, name: &str) -> bool {
    match store.read(service, name) {
        Ok(None) => true,
        Ok(Some(_)) => {
            store.remove(service, name).is_ok()
                && store.read(service, name).is_ok_and(|value| value.is_none())
        }
        Err(_) => false,
    }
}
