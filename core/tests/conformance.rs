use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use libsignal_protocol::{IdentityKey, IdentityKeyPair, KeyPair, PrivateKey, PublicKey};
use obscura_core::crypto::{attachment, link};
use obscura_core::error::{ObscuraError, error_code};
use obscura_core::proto::client::{
    AttachmentPointer, ClientMessage, DirectMessage, FriendRecord, HistorySnapshot, LinkBundle,
    LinkCode, LinkEnvelope, PixMessage, client_message::Payload,
};
use obscura_core::types::{
    ConversationKind, Friend, FriendStatus, MediaType, ObscuraClientConfig, TypingState,
};
use obscura_core::wire::{codec, friend_code, typing::TypingTracker, uuid_codec};
use prost::Message as _;
use serde_json::Value;

fn read_vector_file(name: &str) -> Value {
    let path = format!("tests/fixtures/{name}");
    let text = fs::read_to_string(&path).expect("failed to read conformance vector file");
    serde_json::from_str(&text).expect("failed to parse conformance JSON")
}

#[test]
fn wire_conformance_vectors() {
    let v = read_vector_file("wire.json");

    for item in v["messageTypes"].as_array().unwrap() {
        let wire_name = item["wire"].as_str().unwrap();
        let app_name = item["app"].as_str().unwrap();
        let payload = match wire_name {
            "friend_request" => Some(Payload::FriendRequest(Default::default())),
            "friend_accept" => Some(Payload::FriendAccept(Default::default())),
            "typing_signal" => Some(Payload::TypingSignal(Default::default())),
            "friend_list_sync" => Some(Payload::FriendListSync(Default::default())),
            "direct_message" => Some(Payload::DirectMessage(Default::default())),
            "pix" => Some(Payload::Pix(Default::default())),
            "seen_receipt" => Some(Payload::SeenReceipt(Default::default())),
            "story" => Some(Payload::Story(Default::default())),
            "profile" => Some(Payload::Profile(Default::default())),
            other => panic!("unexpected wire messageType: {other}"),
        };
        assert_eq!(codec::kind(payload.as_ref()), app_name);
    }
    assert_eq!(codec::kind(None), "UNKNOWN");

    for item in v["typingStates"].as_array().unwrap() {
        let wire_str = item["wire"].as_str().unwrap();
        let app_str = item["app"].as_str().unwrap();
        let (wire_val, expected_app) = match (wire_str, app_str) {
            ("TYPING_STATE_STARTED", "started") => (
                obscura_core::proto::client::TypingState::Started as i32,
                TypingState::Started,
            ),
            ("TYPING_STATE_STOPPED", "stopped") => (
                obscura_core::proto::client::TypingState::Stopped as i32,
                TypingState::Stopped,
            ),
            _ => panic!("unexpected typingState vector: {wire_str} / {app_str}"),
        };
        assert_eq!(codec::decode_typing_state(wire_val), Some(expected_app));
        assert_eq!(codec::encode_typing_state(expected_app), wire_val);
    }
    assert_eq!(codec::decode_typing_state(0), None);
    assert_eq!(codec::decode_typing_state(999), None);

    for item in v["mediaTypes"].as_array().unwrap() {
        let wire_str = item["wire"].as_str().unwrap();
        let app_str = item["app"].as_str().unwrap();
        let decoded = MediaType::from_wire(wire_str);
        assert_eq!(decoded.as_str(), app_str);
    }

    for item in v["conversationKinds"].as_array().unwrap() {
        let wire_str = item["wire"].as_str().unwrap();
        let app_str = item["app"].as_str().unwrap();
        let decoded = ConversationKind::from_wire(wire_str).unwrap();
        assert_eq!(decoded.as_str(), app_str);
    }
    assert!(ConversationKind::from_wire("invalid").is_err());

    for case in v["roundTrip"].as_array().unwrap() {
        if let Some(dm) = case.get("directMessage") {
            let msg = ClientMessage {
                timestamp: dm["timestamp"].as_u64().unwrap(),
                payload: Some(Payload::DirectMessage(DirectMessage {
                    id: dm["id"].as_str().unwrap().to_owned(),
                    peer_user_id: dm["peerUserId"].as_str().unwrap().to_owned(),
                    content: dm["content"].as_str().unwrap().to_owned(),
                })),
            };
            let decoded = ClientMessage::decode(&msg.encode_to_vec()[..]).unwrap();
            assert_eq!(decoded.timestamp, dm["timestamp"].as_u64().unwrap());
            let Some(Payload::DirectMessage(decoded_dm)) = decoded.payload else {
                panic!("expected DirectMessage");
            };
            assert_eq!(decoded_dm.id, dm["id"].as_str().unwrap());
            assert_eq!(decoded_dm.peer_user_id, dm["peerUserId"].as_str().unwrap());
            assert_eq!(decoded_dm.content, dm["content"].as_str().unwrap());
        } else if let Some(px) = case.get("pix") {
            let msg = ClientMessage {
                timestamp: px["timestamp"].as_u64().unwrap(),
                payload: Some(Payload::Pix(PixMessage {
                    id: px["id"].as_str().unwrap().to_owned(),
                    peer_user_id: px["peerUserId"].as_str().unwrap().to_owned(),
                    attachment: Some(AttachmentPointer {
                        id: px["attachmentId"].as_str().unwrap().to_owned(),
                        content_key: hex::decode(px["contentKey"].as_str().unwrap()).unwrap(),
                        nonce: hex::decode(px["nonce"].as_str().unwrap()).unwrap(),
                        media_type: px["mediaType"].as_str().unwrap().to_owned(),
                    }),
                    caption: px["caption"].as_str().unwrap().to_owned(),
                    caption_meta: px["captionMeta"].as_str().unwrap().to_owned(),
                    display_duration_secs: px["displayDurationSecs"].as_u64().unwrap() as u32,
                })),
            };
            let decoded = ClientMessage::decode(&msg.encode_to_vec()[..]).unwrap();
            assert_eq!(decoded.timestamp, px["timestamp"].as_u64().unwrap());
            let Some(Payload::Pix(decoded_px)) = decoded.payload else {
                panic!("expected PixMessage");
            };
            assert_eq!(decoded_px.id, px["id"].as_str().unwrap());
            assert_eq!(decoded_px.peer_user_id, px["peerUserId"].as_str().unwrap());
            let att = decoded_px.attachment.unwrap();
            assert_eq!(att.id, px["attachmentId"].as_str().unwrap());
            assert_eq!(
                hex::encode(att.content_key),
                px["contentKey"].as_str().unwrap()
            );
            assert_eq!(hex::encode(att.nonce), px["nonce"].as_str().unwrap());
            assert_eq!(att.media_type, px["mediaType"].as_str().unwrap());
            assert_eq!(decoded_px.caption, px["caption"].as_str().unwrap());
            assert_eq!(decoded_px.caption_meta, px["captionMeta"].as_str().unwrap());
            assert_eq!(
                decoded_px.display_duration_secs,
                px["displayDurationSecs"].as_u64().unwrap() as u32
            );
        }
    }

    assert!(
        codec::decode_friend(&FriendRecord {
            user_id: "019f025a-0000-7de6-84b6-000000000002".to_owned(),
            username: "alice".to_owned(),
            status: 999,
        })
        .is_none()
    );
    assert!(
        codec::decode_friend(&FriendRecord {
            user_id: "   ".to_owned(),
            username: "alice".to_owned(),
            status: obscura_core::proto::client::FriendStatus::Accepted as i32,
        })
        .is_none()
    );
}

#[test]
fn link_conformance_vectors() {
    let v = read_vector_file("link.json");

    for env_vec in v["envelopes"].as_array().unwrap() {
        let new_dev_priv = PrivateKey::deserialize(
            &hex::decode(env_vec["newDevicePrivateKey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let primary_priv = PrivateKey::deserialize(
            &hex::decode(env_vec["primaryPrivateKey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            hex::encode(new_dev_priv.public_key().unwrap().serialize()),
            env_vec["newDevicePublicKey"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(primary_priv.public_key().unwrap().serialize()),
            env_vec["primaryPublicKey"].as_str().unwrap()
        );

        let new_dev_pub = PublicKey::deserialize(
            &hex::decode(env_vec["newDevicePublicKey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let primary_pub = PublicKey::deserialize(
            &hex::decode(env_vec["primaryPublicKey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();

        let shared = new_dev_priv.calculate_agreement(&primary_pub).unwrap();
        assert_eq!(
            hex::encode(&shared),
            env_vec["sharedSecret"].as_str().unwrap()
        );
        let shared_from_primary = primary_priv.calculate_agreement(&new_dev_pub).unwrap();
        assert_eq!(
            hex::encode(&shared_from_primary),
            env_vec["sharedSecret"].as_str().unwrap()
        );

        let key = link::derive_key(&shared);
        assert_eq!(hex::encode(key), env_vec["key"].as_str().unwrap());

        let plaintext = hex::decode(env_vec["plaintext"].as_str().unwrap()).unwrap();
        let nonce = hex::decode(env_vec["nonce"].as_str().unwrap()).unwrap();
        let primary_kp = KeyPair::new(primary_pub, primary_priv);
        let sealed = link::seal_with(&plaintext, &new_dev_pub, &primary_kp, &nonce).unwrap();
        assert_eq!(
            hex::encode(&sealed.ciphertext),
            env_vec["ciphertext"].as_str().unwrap()
        );
        assert_eq!(
            link::open(&sealed.encode_to_vec(), &new_dev_priv).unwrap(),
            plaintext
        );

        let raw_envelope = hex::decode(env_vec["linkEnvelope"].as_str().unwrap()).unwrap();
        assert_eq!(link::open(&raw_envelope, &new_dev_priv).unwrap(), plaintext);
        let parsed_env = LinkEnvelope::decode(&raw_envelope[..]).unwrap();
        assert_eq!(parsed_env, sealed);

        let expected = &env_vec["linkBundle"];
        let bundle = LinkBundle::decode(&plaintext[..]).unwrap();
        assert_eq!(
            hex::encode(&bundle.identity_key_pair),
            expected["identityKeyPair"].as_str().unwrap()
        );
        assert_eq!(bundle.user_id, expected["userId"].as_str().unwrap());
        assert_eq!(bundle.username, expected["username"].as_str().unwrap());
        assert_eq!(
            bundle.primary_device_id,
            expected["primaryDeviceId"].as_str().unwrap()
        );
        assert_eq!(
            bundle.friend_list_version,
            expected["friendListVersion"].as_u64().unwrap()
        );

        let expected_friends: Vec<Friend> = expected["friends"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| Friend {
                user_id: f["userId"].as_str().unwrap().to_owned(),
                username: f["username"].as_str().unwrap().to_owned(),
                status: match f["status"].as_str().unwrap() {
                    "FRIEND_STATUS_PENDING_SENT" => FriendStatus::PendingSent,
                    "FRIEND_STATUS_PENDING_RECEIVED" => FriendStatus::PendingReceived,
                    "FRIEND_STATUS_ACCEPTED" => FriendStatus::Accepted,
                    other => panic!("unexpected friend status: {other}"),
                },
            })
            .collect();
        let decoded_friends: Vec<Friend> = bundle
            .friends
            .iter()
            .map(|r| codec::decode_friend(r).unwrap())
            .collect();
        assert_eq!(decoded_friends, expected_friends);

        let identity = IdentityKeyPair::try_from(&bundle.identity_key_pair[..]).unwrap();
        assert_eq!(
            hex::encode(identity.private_key().serialize()),
            expected["identityPrivateKey"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(identity.public_key().serialize()),
            expected["identityPublicKey"].as_str().unwrap()
        );
        let rebuilt = IdentityKeyPair::new(
            IdentityKey::decode(
                &hex::decode(expected["identityPublicKey"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
            PrivateKey::deserialize(
                &hex::decode(expected["identityPrivateKey"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
        );
        assert_eq!(
            hex::encode(rebuilt.serialize()),
            expected["identityKeyPair"].as_str().unwrap()
        );

        let own_history = expected.get("history").map(|h| HistorySnapshot {
            attachment_id: h["attachmentId"].as_str().unwrap().to_owned(),
            content_key: hex::decode(h["contentKey"].as_str().unwrap()).unwrap(),
            nonce: hex::decode(h["nonce"].as_str().unwrap()).unwrap(),
        });
        let own_bundle = LinkBundle {
            identity_key_pair: rebuilt.serialize().into_vec(),
            user_id: expected["userId"].as_str().unwrap().to_owned(),
            primary_device_id: expected["primaryDeviceId"].as_str().unwrap().to_owned(),
            username: expected["username"].as_str().unwrap().to_owned(),
            friend_list_version: expected["friendListVersion"].as_u64().unwrap(),
            friends: expected_friends.iter().map(codec::encode_friend).collect(),
            history: own_history,
        };
        assert_eq!(bundle, own_bundle);
    }

    for code_vec in v["linkCodes"].as_array().unwrap() {
        let code_str = code_vec["code"].as_str().unwrap();
        let decoded = link::decode_code(code_str).unwrap();
        assert_eq!(decoded.session_id, code_vec["sessionId"].as_str().unwrap());
        assert_eq!(
            hex::encode(&decoded.ephemeral_public_key),
            code_vec["ephemeralPublicKey"].as_str().unwrap()
        );
        assert_eq!(
            decoded.device_name,
            code_vec["deviceName"].as_str().unwrap()
        );
        assert_eq!(
            link::link_code_device_name(code_str.to_owned()).unwrap(),
            code_vec["deviceName"].as_str().unwrap()
        );

        let own = LinkCode {
            session_id: code_vec["sessionId"].as_str().unwrap().to_owned(),
            ephemeral_public_key: hex::decode(code_vec["ephemeralPublicKey"].as_str().unwrap())
                .unwrap(),
            device_name: code_vec["deviceName"].as_str().unwrap().to_owned(),
        };
        assert_eq!(link::decode_code(&link::encode_code(&own)).unwrap(), own);
        let decorated = format!(" \n{}\u{00AD} {}\t ", &code_str[..4], &code_str[4..]);
        assert_eq!(link::decode_code(&decorated).unwrap(), own);
        assert_eq!(decoded, own);
    }

    let own_priv = KeyPair::generate(&mut rand::rng()).private_key;
    assert!(matches!(
        link::open(&[0xff, 0xff, 0xff], &own_priv),
        Err(ObscuraError::LinkFailed { .. })
    ));
    let bad_nonce_env = LinkEnvelope {
        ephemeral_public_key: vec![],
        nonce: vec![1, 2, 3],
        ciphertext: vec![],
    };
    assert!(matches!(
        link::open(&bad_nonce_env.encode_to_vec(), &own_priv),
        Err(ObscuraError::LinkFailed { .. })
    ));
    let bad_key_env = LinkEnvelope {
        ephemeral_public_key: vec![1, 2, 3],
        nonce: vec![0u8; 12],
        ciphertext: vec![],
    };
    assert!(matches!(
        link::open(&bad_key_env.encode_to_vec(), &own_priv),
        Err(ObscuraError::LinkFailed { .. })
    ));
}

#[test]
fn friend_code_uuid_attachment_typing_and_config_validation() {
    // FriendCode
    let encoded = friend_code::encode("019f025a-3745-7de6-84b6-d932cae7d45f", "✨nolan✨");
    let decorated = format!(" \n{}\u{00AD} {}\t ", &encoded[..4], &encoded[4..]);
    let url_safe = decorated.replace('+', "-").replace('/', "_");
    let decoded = friend_code::decode(&url_safe).unwrap();
    assert_eq!(decoded.user_id, "019f025a-3745-7de6-84b6-d932cae7d45f");
    assert_eq!(decoded.username, "✨nolan✨");
    assert_eq!(
        friend_code::decode(""),
        Err(ObscuraError::InvalidFriendCode)
    );
    assert_eq!(
        friend_code::decode("not base64!!!"),
        Err(ObscuraError::InvalidFriendCode)
    );
    assert_eq!(
        friend_code::decode("e30="),
        Err(ObscuraError::InvalidFriendCode)
    );

    // UuidCodec
    let u = "019f025a-3745-7de6-84b6-d932cae7d45f";
    let bytes = uuid_codec::uuid_to_bytes(u).unwrap();
    assert_eq!(bytes.len(), 16);
    assert_eq!(uuid_codec::uuid_string(&bytes).as_deref(), Some(u));
    assert_eq!(uuid_codec::uuid_string(&[1, 2, 3]), None);
    assert!(uuid_codec::is_uuid(u));
    assert!(!uuid_codec::is_uuid("0-0-0-0-0"));
    assert!(!uuid_codec::is_uuid("not-a-uuid"));

    // AttachmentCrypto & cache
    let encrypted = attachment::encrypt(b"hello attachment").unwrap();
    let decrypted = attachment::decrypt(
        &encrypted.ciphertext,
        &encrypted.content_key,
        &encrypted.nonce,
    )
    .unwrap();
    assert_eq!(decrypted, b"hello attachment");
    assert!(attachment::decrypt(&encrypted.ciphertext, &[0u8; 32], &encrypted.nonce).is_err());

    let temp_dir = tempfile::tempdir().unwrap();
    let mov_bytes = b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00";
    let mp4_bytes = b"\x00\x00\x00\x14ftypisom\x00\x00\x00\x00";
    let jpg_bytes = b"\xff\xd8\xff\xe0jpegdata";
    let mov_path = attachment::write_cached(temp_dir.path(), "att/1", mov_bytes).unwrap();
    assert!(mov_path.to_string_lossy().ends_with("att_1.mov"));
    assert_eq!(
        attachment::read_cached(temp_dir.path(), "att/1"),
        Some(mov_path)
    );
    attachment::purge_cached(temp_dir.path(), "att/1");
    assert_eq!(attachment::read_cached(temp_dir.path(), "att/1"), None);

    let mp4_path = attachment::write_cached(temp_dir.path(), "att_2", mp4_bytes).unwrap();
    assert!(mp4_path.to_string_lossy().ends_with("att_2.mp4"));
    let jpg_path = attachment::write_cached(temp_dir.path(), "att_3", jpg_bytes).unwrap();
    assert!(jpg_path.to_string_lossy().ends_with("att_3.jpg"));
    attachment::purge_all_cached(temp_dir.path());
    assert_eq!(attachment::read_cached(temp_dir.path(), "att_2"), None);

    // Error codes
    let cases = [
        (ObscuraError::NotAuthenticated, "NOT_AUTHENTICATED"),
        (ObscuraError::invalid_arg("x"), "INVALID_ARGUMENT"),
        (ObscuraError::InvalidFriendCode, "INVALID_FRIEND_CODE"),
        (ObscuraError::connection("x"), "CONNECTION_FAILED"),
        (ObscuraError::protocol("x"), "PROTOCOL_VIOLATION"),
        (ObscuraError::storage("x"), "STORAGE_ERROR"),
        (
            ObscuraError::DatabaseUndecryptable {
                reason: "x".to_owned(),
            },
            "STORAGE_ERROR",
        ),
        (ObscuraError::send_failed("x"), "SEND_FAILED"),
        (ObscuraError::NotPrimary, "NOT_PRIMARY"),
        (ObscuraError::link_failed("x"), "LINK_FAILED"),
        (
            ObscuraError::Http {
                status: 500,
                body: "err".to_owned(),
            },
            "HTTP_ERROR",
        ),
    ];
    for (err, code) in cases {
        assert_eq!(error_code(&err), code);
    }

    // Config validation
    for valid_url in [
        "https://api.obscura.example",
        "http://localhost:3000",
        "http://127.0.0.1:8080",
        "http://[::1]:3000",
    ] {
        let cfg = ObscuraClientConfig {
            api_url: valid_url.to_owned(),
            database_path: None,
            database_key: vec![],
            device_name: "Pixel".to_owned(),
            attachment_cache_dir: None,
        };
        assert!(cfg.validate().is_ok(), "should accept {valid_url}");
    }
    for invalid_url in [
        "http://api.obscura.example",
        "http://localhost@evil.com",
        "https://api.obscura.example?foo=1",
        "https://api.obscura.example#frag",
        "https://api.obscura.example:0",
        "https://api.obscura.example:70000",
        "ftp://localhost",
    ] {
        let cfg = ObscuraClientConfig {
            api_url: invalid_url.to_owned(),
            database_path: None,
            database_key: vec![],
            device_name: "Pixel".to_owned(),
            attachment_cache_dir: None,
        };
        assert!(cfg.validate().is_err(), "should reject {invalid_url}");
    }

    // TypingTracker
    let events: Arc<Mutex<Vec<(String, bool)>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&events);
    let tracker = TypingTracker::with_expiry(
        80,
        Some(Arc::new(move |peer, is_typing| {
            events_clone
                .lock()
                .unwrap()
                .push((peer.to_owned(), is_typing));
        })),
    );
    assert!(tracker.should_send("ctx1", TypingState::Started, 1000));
    assert!(!tracker.should_send("ctx1", TypingState::Started, 2500));
    assert!(tracker.should_send("ctx1", TypingState::Started, 3000));
    assert!(tracker.should_send("ctx1", TypingState::Stopped, 1500));

    tracker.observe_peer("bob", "alice_bob");
    tracker.started("alice_bob", "bob", "dev2");
    tracker.started("alice_bob", "alice", "dev1");
    assert_eq!(tracker.active_users("alice_bob"), vec!["alice", "bob"]);
    std::thread::sleep(Duration::from_millis(150));
    assert!(tracker.active_users("alice_bob").is_empty());
    let recorded = events.lock().unwrap().clone();
    assert_eq!(
        recorded,
        vec![
            ("bob".to_owned(), false),
            ("bob".to_owned(), true),
            ("bob".to_owned(), false),
        ]
    );
}
