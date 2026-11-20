use crate::web::Failure;

#[derive(Clone, Copy)]
pub(crate) enum PeerError {
    Timeout,
    ConnectionLost,
    IntegrityMismatch,
    SizeLimit,
    PermissionRevoked,
    LauncherUnavailable,
    Unconfirmed,
    GitHubUnsupported,
}

impl PeerError {
    fn spec(self) -> (u16, &'static str, &'static str) {
        match self {
            Self::Timeout => (
                504,
                "peer_transfer_timeout",
                "Peer release transfer timed out.",
            ),
            Self::ConnectionLost => (
                502,
                "peer_connection_lost",
                "Peer release connection was lost.",
            ),
            Self::IntegrityMismatch => (
                502,
                "peer_integrity_mismatch",
                "Peer release failed integrity checks.",
            ),
            Self::SizeLimit => (
                413,
                "peer_size_limit",
                "Peer release exceeds size or file count limits.",
            ),
            Self::PermissionRevoked => (
                403,
                "peer_permission_revoked",
                "Machine updates require permission from both owners in Settings > Machines.",
            ),
            Self::GitHubUnsupported => (
                409,
                "peer_github_unsupported",
                "Receiving machine uses the local feed.",
            ),
            Self::Unconfirmed => (
                503,
                "peer_update_unconfirmed",
                "Could not confirm the peer update. Check the receiving machine for its result.",
            ),
            Self::LauncherUnavailable => (
                409,
                "peer_launcher_unavailable",
                "Receiving machine is not running under the Minarbot launcher.",
            ),
        }
    }

    pub(crate) fn code(self) -> &'static str {
        self.spec().1
    }

    pub(crate) fn failure(self) -> Failure {
        let (status, code, message) = self.spec();
        Failure::new(status, code, message)
    }

    pub(crate) fn detail(self, message: impl Into<String>) -> Failure {
        let (status, code, _) = self.spec();
        Failure::new(status, code, message)
    }

    pub(crate) fn from_code(code: &str) -> Option<Failure> {
        [
            Self::Timeout,
            Self::ConnectionLost,
            Self::IntegrityMismatch,
            Self::SizeLimit,
            Self::PermissionRevoked,
            Self::LauncherUnavailable,
            Self::Unconfirmed,
        ]
        .into_iter()
        .find(|error| error.code() == code)
        .map(Self::failure)
    }

    pub(crate) fn network(error: reqwest::Error) -> Failure {
        if error.is_timeout() {
            Self::Timeout.failure()
        } else {
            Self::ConnectionLost.failure()
        }
    }
}
