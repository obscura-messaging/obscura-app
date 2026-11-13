//! Wire and record interop with libsignal-client as the kits use it.
//!
//! `fixtures/kotlin-to-core.json` comes from the Kotlin kit's `InteropFixtureTest`; core decrypts
//! it here. `fixtures/core-to-kotlin.json` is written by this file when
//! `OBSCURA_WRITE_FIXTURES=1`, and the Kotlin test decrypts it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use futures::executor::block_on;
use libsignal_protocol::{
    GenericSignedPreKey, IdentityKeyPair, KeyPair, KyberPreKeyRecord, KyberPreKeyStore,
    PreKeyRecord, PreKeySignalMessage, PreKeyStore, SignedPreKeyRecord, Timestamp, kem,
};
use obscura_core::store::SqlStore;
use obscura_core::{Ciphertext, CiphertextKind, PreKeyBundleData, SpikeClient};
use serde_json::{Value, json};

const KEY: [u8; 32] = [0x5A; 32];
const CORE_PLAINTEXTS: [&str; 2] = ["hello from core 1", "hello from core 2"];

fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn b64(v: &Value) -> Vec<u8> {
    B64.decode(v.as_str().expect("base64 string"))
        .expect("standard base64")
}

fn u32_of(v: &Value) -> u32 {
    u32::try_from(v.as_u64().expect("number")).expect("u32")
}

/// Bob, rebuilt only from the fixture's records, decrypts every message in order.
/// Returns his client and the fixture's sender address.
fn assert_fixture_decrypts(dir: &Path, fixture: &Value) -> (Arc<SpikeClient>, String, u32) {
    assert_eq!(fixture["libsignalVersion"], "0.106.2");
    let r = &fixture["recipient"];
    let s = &fixture["sender"];
    let db = dir.join("bob.db");

    let store = SqlStore::open(&db, &KEY).unwrap();
    store
        .import_identity(&b64(&r["identityKeyPair"]), u32_of(&r["registrationId"]))
        .unwrap();
    store
        .import_signed_pre_key(&b64(&r["signedPreKeyRecord"]))
        .unwrap();
    let kyber = KyberPreKeyRecord::deserialize(&b64(&r["kyberPreKeyRecord"])).unwrap();
    // Both fixtures carry a one-time Kyber prekey, as a bundle from the kits' servers usually does.
    store
        .import_kyber_pre_key(&b64(&r["kyberPreKeyRecord"]), false)
        .unwrap();
    let pre_key = PreKeyRecord::deserialize(&b64(&r["preKeyRecord"])).unwrap();
    store.import_pre_key(&b64(&r["preKeyRecord"])).unwrap();

    let bob = SpikeClient::open(
        db.to_str().unwrap().to_owned(),
        KEY.to_vec(),
        r["name"].as_str().unwrap().to_owned(),
        u32_of(&r["deviceId"]),
    )
    .unwrap();
    let sender = s["name"].as_str().unwrap().to_owned();
    let sender_device = u32_of(&s["deviceId"]);
    let sender_identity = b64(&s["identityKey"]);

    let messages = fixture["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    for m in messages {
        assert_eq!(m["kind"], "prekey");
        let bytes = b64(&m["ciphertext"]);
        let parsed = PreKeySignalMessage::try_from(&bytes[..]).unwrap();
        assert_eq!(&parsed.identity_key().serialize()[..], &sender_identity[..]);
        let plaintext = bob
            .decrypt(
                sender.clone(),
                sender_device,
                Ciphertext {
                    kind: CiphertextKind::PreKey,
                    bytes,
                },
            )
            .unwrap();
        assert_eq!(plaintext, m["plaintext"].as_str().unwrap().as_bytes());
    }

    // As in the kits, both one-time keys were consumed by the first message.
    assert!(block_on(store.get_kyber_pre_key(kyber.id().unwrap())).is_err());
    assert!(block_on(store.get_pre_key(pre_key.id().unwrap())).is_err());
    (bob, sender, sender_device)
}

#[test]
fn decrypts_kotlin_fixture_and_replies() {
    let raw = std::fs::read_to_string(fixture_path("kotlin-to-core.json")).unwrap();
    let fixture: Value = serde_json::from_str(&raw).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (bob, alice, alice_device) = assert_fixture_decrypts(dir.path(), &fixture);

    let reply = bob
        .encrypt(alice, alice_device, b"hello back from core".to_vec())
        .unwrap();
    assert_eq!(reply.kind, CiphertextKind::Whisper);
    assert!(!reply.bytes.is_empty());
}

/// Bob's records as core generates and serializes them, with the Kotlin fixture's ids:
/// signed prekey 1, one-time Kyber-1024 prekey 2, one-time EC prekey 3.
struct BobRecords {
    identity: IdentityKeyPair,
    registration_id: u32,
    signed: SignedPreKeyRecord,
    kyber: KyberPreKeyRecord,
    pre_key: PreKeyRecord,
}

impl BobRecords {
    fn generate() -> Self {
        let mut rng = rand::rng();
        let identity = IdentityKeyPair::generate(&mut rng);
        let pair = KeyPair::generate(&mut rng);
        let signature = identity
            .private_key()
            .calculate_signature(&pair.public_key.serialize(), &mut rng)
            .unwrap();
        Self {
            registration_id: 4321,
            signed: SignedPreKeyRecord::new(
                1.into(),
                Timestamp::from_epoch_millis(0),
                &pair,
                &signature,
            ),
            kyber: KyberPreKeyRecord::generate(
                kem::KeyType::Kyber1024,
                2.into(),
                identity.private_key(),
            )
            .unwrap(),
            pre_key: PreKeyRecord::new(3.into(), &KeyPair::generate(&mut rng)),
            identity,
        }
    }

    fn bundle(&self) -> PreKeyBundleData {
        PreKeyBundleData {
            registration_id: self.registration_id,
            device_id: 1,
            identity_key: self.identity.identity_key().serialize().into_vec(),
            signed_pre_key_id: 1,
            signed_pre_key: self.signed.public_key().unwrap().serialize().into_vec(),
            signed_pre_key_signature: self.signed.signature().unwrap(),
            kyber_pre_key_id: 2,
            kyber_pre_key: self.kyber.public_key().unwrap().serialize().into_vec(),
            kyber_pre_key_signature: self.kyber.signature().unwrap(),
            pre_key_id: Some(3),
            pre_key: Some(self.pre_key.public_key().unwrap().serialize().into_vec()),
        }
    }
}

fn build_core_fixture(dir: &Path) -> Value {
    let bob = BobRecords::generate();
    let alice = SpikeClient::open(
        dir.join("alice.db").to_str().unwrap().to_owned(),
        KEY.to_vec(),
        "alice".into(),
        1,
    )
    .unwrap();
    let alice_identity = alice.create_identity_and_bundle().unwrap().identity_key;
    alice.process_bundle("bob".into(), 1, bob.bundle()).unwrap();
    let messages: Vec<Value> = CORE_PLAINTEXTS
        .iter()
        .map(|text| {
            let ct = alice
                .encrypt("bob".into(), 1, text.as_bytes().to_vec())
                .unwrap();
            assert_eq!(ct.kind, CiphertextKind::PreKey, "no reply yet");
            json!({ "kind": "prekey", "ciphertext": B64.encode(&ct.bytes), "plaintext": text })
        })
        .collect();
    json!({
        "libsignalVersion": "0.106.2",
        "recipient": {
            "name": "bob",
            "deviceId": 1,
            "registrationId": bob.registration_id,
            "identityKeyPair": B64.encode(bob.identity.serialize()),
            "signedPreKeyRecord": B64.encode(bob.signed.serialize().unwrap()),
            "kyberPreKeyRecord": B64.encode(bob.kyber.serialize().unwrap()),
            "preKeyRecord": B64.encode(bob.pre_key.serialize().unwrap()),
        },
        "sender": { "name": "alice", "deviceId": 1, "identityKey": B64.encode(&alice_identity) },
        "messages": messages,
    })
}

/// The round trip always runs; `OBSCURA_WRITE_FIXTURES=1` also writes the fixture for the
/// Kotlin kit's `InteropFixtureTest` to decrypt with libsignal-client.
#[test]
fn core_fixture_round_trips_and_is_written_on_request() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = build_core_fixture(dir.path());
    let bob_dir = tempfile::tempdir().unwrap();
    assert_fixture_decrypts(bob_dir.path(), &fixture);
    if std::env::var("OBSCURA_WRITE_FIXTURES").as_deref() == Ok("1") {
        let mut text = serde_json::to_string_pretty(&fixture).unwrap();
        text.push('\n');
        std::fs::write(fixture_path("core-to-kotlin.json"), text).unwrap();
    }
}

/// The committed fixture is the one Kotlin decrypts; it must stay valid for core too.
#[test]
fn committed_core_fixture_decrypts() {
    let raw = std::fs::read_to_string(fixture_path("core-to-kotlin.json")).unwrap();
    let fixture: Value = serde_json::from_str(&raw).unwrap();
    let dir = tempfile::tempdir().unwrap();
    assert_fixture_decrypts(dir.path(), &fixture);
}

/// The kits' `markKyberPreKeyUsed`: a one-time key is deleted, a last-resort key is kept and
/// rejects a session started again with the same signed prekey and base key.
#[test]
fn kyber_one_time_is_deleted_and_last_resort_rejects_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SqlStore::open(dir.path().join("k.db"), &KEY).unwrap();
    let identity = IdentityKeyPair::generate(&mut rand::rng());
    let gen_kyber = |id: u32| {
        KyberPreKeyRecord::generate(kem::KeyType::Kyber1024, id.into(), identity.private_key())
            .unwrap()
            .serialize()
            .unwrap()
    };
    store.import_kyber_pre_key(&gen_kyber(10), false).unwrap();
    store.import_kyber_pre_key(&gen_kyber(11), true).unwrap();
    let base = KeyPair::generate(&mut rand::rng()).public_key;
    let other_base = KeyPair::generate(&mut rand::rng()).public_key;

    block_on(store.mark_kyber_pre_key_used(10.into(), 1.into(), &base)).unwrap();
    assert!(block_on(store.get_kyber_pre_key(10.into())).is_err());

    block_on(store.mark_kyber_pre_key_used(11.into(), 1.into(), &base)).unwrap();
    assert!(block_on(store.mark_kyber_pre_key_used(11.into(), 1.into(), &base)).is_err());
    block_on(store.mark_kyber_pre_key_used(11.into(), 1.into(), &other_base)).unwrap();
    block_on(store.mark_kyber_pre_key_used(11.into(), 2.into(), &base)).unwrap();
    assert!(block_on(store.get_kyber_pre_key(11.into())).is_ok());
}
