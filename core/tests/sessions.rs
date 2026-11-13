use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use obscura_core::{Ciphertext, CiphertextKind, CoreError, CoreLogger, SpikeClient, set_logger};

const ALICE_KEY: [u8; 32] = [0xA1; 32];
const BOB_KEY: [u8; 32] = [0xB2; 32];

fn open(path: &Path, key: &[u8], name: &str) -> Arc<SpikeClient> {
    SpikeClient::open(
        path.to_str().unwrap().to_owned(),
        key.to_vec(),
        name.to_owned(),
        1,
    )
    .expect("open")
}

struct Pair {
    _dir: tempfile::TempDir,
    alice_db: PathBuf,
    bob_db: PathBuf,
    alice: Arc<SpikeClient>,
    bob: Arc<SpikeClient>,
}

impl Pair {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let alice_db = dir.path().join("alice.db");
        let bob_db = dir.path().join("bob.db");
        let alice = open(&alice_db, &ALICE_KEY, "alice");
        let bob = open(&bob_db, &BOB_KEY, "bob");
        Self {
            _dir: dir,
            alice_db,
            bob_db,
            alice,
            bob,
        }
    }

    fn reopen(&mut self) {
        // Replace (and so drop) both clients, closing their connections.
        self.alice = open(&self.alice_db, &ALICE_KEY, "alice");
        self.bob = open(&self.bob_db, &BOB_KEY, "bob");
    }
}

fn send(
    from: &SpikeClient,
    from_name: &str,
    to: &SpikeClient,
    to_name: &str,
    text: &str,
) -> CiphertextKind {
    let ct = from
        .encrypt(to_name.to_owned(), 1, text.as_bytes().to_vec())
        .expect("encrypt");
    let kind = ct.kind;
    assert!(!ct.bytes.windows(text.len()).any(|w| w == text.as_bytes()));
    let pt = to.decrypt(from_name.to_owned(), 1, ct).expect("decrypt");
    assert_eq!(pt, text.as_bytes());
    kind
}

fn establish(p: &Pair) {
    let bundle = p.bob.create_identity_and_bundle().unwrap();
    assert!(bundle.pre_key.is_some());
    assert!(bundle.kyber_pre_key.len() > 1500, "Kyber1024 public key");
    p.alice.create_identity_and_bundle().unwrap();
    p.alice.process_bundle("bob".into(), 1, bundle).unwrap();
}

#[test]
fn pqxdh_round_trip_both_directions() {
    let p = Pair::new();
    establish(&p);

    // Until Bob replies, every Alice message carries the PreKey header.
    for i in 0..3 {
        let kind = send(&p.alice, "alice", &p.bob, "bob", &format!("a->b {i}"));
        assert_eq!(kind, CiphertextKind::PreKey);
    }
    for i in 0..4 {
        let kind = send(&p.bob, "bob", &p.alice, "alice", &format!("b->a {i}"));
        assert_eq!(kind, CiphertextKind::Whisper);
    }
    for i in 0..4 {
        let kind = send(&p.alice, "alice", &p.bob, "bob", &format!("a->b again {i}"));
        assert_eq!(kind, CiphertextKind::Whisper);
    }
}

#[test]
fn state_survives_reopen_mid_conversation() {
    let mut p = Pair::new();
    establish(&p);

    // Reopen after processing the bundle but before the first message.
    p.reopen();
    assert_eq!(
        send(&p.alice, "alice", &p.bob, "bob", "first"),
        CiphertextKind::PreKey
    );

    // Reopen after the PreKey message was consumed.
    p.reopen();
    assert_eq!(
        send(&p.bob, "bob", &p.alice, "alice", "reply"),
        CiphertextKind::Whisper
    );
    assert_eq!(
        send(&p.alice, "alice", &p.bob, "bob", "second"),
        CiphertextKind::Whisper
    );

    // Out-of-order delivery across a reopen: skipped message keys must persist too.
    let late = p.alice.encrypt("bob".into(), 1, b"late".to_vec()).unwrap();
    let early = p.alice.encrypt("bob".into(), 1, b"early".to_vec()).unwrap();
    p.reopen();
    assert_eq!(p.bob.decrypt("alice".into(), 1, early).unwrap(), b"early");
    p.reopen();
    assert_eq!(p.bob.decrypt("alice".into(), 1, late).unwrap(), b"late");

    for i in 0..3 {
        send(
            &p.bob,
            "bob",
            &p.alice,
            "alice",
            &format!("after reopen {i}"),
        );
        send(
            &p.alice,
            "alice",
            &p.bob,
            "bob",
            &format!("after reopen ack {i}"),
        );
    }

    // Reopening also keeps the identity: the bundle is stable.
    let before = p.bob.create_identity_and_bundle().unwrap();
    p.reopen();
    let after = p.bob.create_identity_and_bundle().unwrap();
    assert_eq!(before.identity_key, after.identity_key);
    assert_eq!(before.registration_id, after.registration_id);
}

#[test]
fn replayed_prekey_message_fails_without_corrupting_state() {
    let p = Pair::new();
    establish(&p);
    let first = p.alice.encrypt("bob".into(), 1, b"once".to_vec()).unwrap();
    let replay = Ciphertext {
        kind: first.kind,
        bytes: first.bytes.clone(),
    };
    assert_eq!(p.bob.decrypt("alice".into(), 1, first).unwrap(), b"once");
    assert!(p.bob.decrypt("alice".into(), 1, replay).is_err());
    send(&p.bob, "bob", &p.alice, "alice", "still fine");
    send(&p.alice, "alice", &p.bob, "bob", "still fine too");
}

#[test]
fn wrong_key_is_a_storage_error_and_file_is_encrypted() {
    let p = Pair::new();
    establish(&p);
    let Pair {
        alice,
        bob,
        alice_db,
        _dir,
        ..
    } = p;
    drop((alice, bob));

    let err = SpikeClient::open(
        alice_db.to_str().unwrap().to_owned(),
        vec![0x00; 32],
        "alice".into(),
        1,
    )
    .err()
    .expect("wrong key must fail");
    assert!(matches!(err, CoreError::Storage { .. }), "{err:?}");

    let bytes = std::fs::read(&alice_db).unwrap();
    assert!(bytes.len() > 1024);
    assert!(!bytes.starts_with(b"SQLite format 3\0"));
    assert!(
        !bytes
            .windows(b"local_identity".len())
            .any(|w| w == b"local_identity")
    );

    // And the right key still works afterwards.
    open(&alice_db, &ALICE_KEY, "alice");
}

#[test]
fn short_key_is_invalid_argument() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("x.db");
    let err = SpikeClient::open(
        path.to_str().unwrap().to_owned(),
        vec![1; 16],
        "x".into(),
        1,
    )
    .err()
    .unwrap();
    assert!(matches!(err, CoreError::InvalidArgument { .. }), "{err:?}");
}

struct Collect(Mutex<Vec<String>>);

impl CoreLogger for Collect {
    fn log(&self, message: String) {
        self.0.lock().unwrap().push(message);
    }
}

#[test]
fn logger_receives_messages() {
    let logger = Arc::new(Collect(Mutex::new(Vec::new())));
    set_logger(logger.clone());
    let p = Pair::new();
    establish(&p);
    send(&p.alice, "alice", &p.bob, "bob", "logged");
    let logs = logger.0.lock().unwrap().clone();
    assert!(logs.iter().any(|m| m.contains("opened store")), "{logs:?}");
    assert!(
        logs.iter().any(|m| m.contains("encrypted PreKey")),
        "{logs:?}"
    );
    assert!(
        logs.iter().any(|m| m.contains("decrypted PreKey")),
        "{logs:?}"
    );
    assert!(
        !logs.iter().any(|m| m.contains("logged")),
        "plaintext leaked into logs"
    );
}

#[test]
fn decrypt_async_round_trips() {
    let p = Pair::new();
    establish(&p);
    let first = p
        .alice
        .encrypt("bob".into(), 1, b"async 1".to_vec())
        .unwrap();
    let pt = futures::executor::block_on(p.bob.clone().decrypt_async("alice".into(), 1, first));
    assert_eq!(pt.unwrap(), b"async 1");
    send(&p.bob, "bob", &p.alice, "alice", "sync reply");
    let second = p
        .alice
        .encrypt("bob".into(), 1, b"async 2".to_vec())
        .unwrap();
    assert_eq!(second.kind, CiphertextKind::Whisper);
    let pt = futures::executor::block_on(p.bob.clone().decrypt_async("alice".into(), 1, second));
    assert_eq!(pt.unwrap(), b"async 2");
}
