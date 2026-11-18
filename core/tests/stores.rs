use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use futures::executor::block_on;
use libsignal_protocol::{
    CiphertextMessage, GenericSignedPreKey, IdentityKeyPair, PreKeyBundle, PreKeySignalMessage,
    message_decrypt, message_encrypt, process_prekey_bundle,
};
use obscura_core::crypto::{attachment, prekeys};
use obscura_core::error::ObscuraError;
use obscura_core::store::signal_store::{
    ARCHIVE_AGE_MS, MIN_ONE_TIME_KEPT, STALE_ONE_TIME_AGE_MS, SignalStore, address_for,
};
use obscura_core::store::{
    DbHandle, PostCommitEffect, content_store, device_store,
    friend_store::{self, FriendList},
    history_sync,
};
use obscura_core::types::{
    ConversationItem, EntryModel, Friend, FriendStatus, MediaAttachment, MediaType, ProfileItem,
    StoryItem, expires_at,
};

#[tokio::test]
async fn sqlcipher_key_verification_legacy_cutover_and_open_path_registry() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("obscura_test.db");
    let db_path_str = db_path.to_str().unwrap();
    let key_a = [0x11u8; 32];
    let key_b = [0x22u8; 32];

    // Invalid key length rejected
    assert!(matches!(
        DbHandle::open(Some(db_path_str), &[1, 2, 3], None),
        Err(ObscuraError::InvalidArgument { .. })
    ));

    let db = DbHandle::open(Some(db_path_str), &key_a, None).unwrap();

    // Concurrent open on the same path is forbidden while open
    assert!(matches!(
        DbHandle::open(Some(db_path_str), &key_a, None),
        Err(ObscuraError::InvalidArgument { .. })
    ));

    db.shutdown().await;

    // Wrong key returns DatabaseUndecryptable, and unregisters the path so a retry works!
    assert!(matches!(
        DbHandle::open(Some(db_path_str), &key_b, None),
        Err(ObscuraError::DatabaseUndecryptable { .. })
    ));

    // Reopening with the right key works immediately after failed open
    let db2 = DbHandle::open(Some(db_path_str), &key_a, None).unwrap();
    // Simulate a legacy pre-Rust database (user_version = 0 with existing tables)
    db2.raw(|conn| {
        conn.execute_batch("PRAGMA user_version = 0;")?;
        Ok(())
    })
    .await
    .unwrap();
    db2.shutdown().await;

    assert!(matches!(
        DbHandle::open(Some(db_path_str), &key_a, None),
        Err(ObscuraError::DatabaseUndecryptable { .. })
    ));
}

#[tokio::test]
async fn pqxdh_session_kyber_one_time_vs_last_resort_replay_and_identity_cascade() {
    let effects: Arc<Mutex<Vec<PostCommitEffect>>> = Arc::new(Mutex::new(Vec::new()));
    let eff_clone = Arc::clone(&effects);
    let alice_db = DbHandle::open(
        None,
        &[],
        Some(Arc::new(move |eff| {
            eff_clone.lock().unwrap().push(eff);
        })),
    )
    .unwrap();
    let bob_db = DbHandle::open(None, &[], None).unwrap();

    let alice_uid = "11111111-1111-4111-8111-111111111111";
    let alice_dev = "11111111-1111-4111-8111-1111111111d1";
    let bob_uid = "22222222-2222-4222-8222-222222222222";
    let bob_dev1 = "22222222-2222-4222-8222-2222222222d1";
    let bob_dev2 = "22222222-2222-4222-8222-2222222222d2";

    let alice_keys =
        prekeys::generate_provisioning_keys(IdentityKeyPair::generate(&mut rand::rng()), 1_000)
            .await
            .unwrap();
    let bob_identity = IdentityKeyPair::generate(&mut rand::rng());
    let bob_keys = prekeys::generate_provisioning_keys(bob_identity, 1_000)
        .await
        .unwrap();

    alice_db
        .write_tx(move |ctx| {
            prekeys::install(ctx.conn, &alice_keys)?;
            device_store::store_local(
                ctx.conn,
                alice_uid,
                &device_store::LocalDevice {
                    device_id: alice_dev.to_owned(),
                    primary_device_id: alice_dev.to_owned(),
                },
            )
        })
        .await
        .unwrap();

    let bob_keys_clone = bob_keys.clone();
    bob_db
        .write_tx(move |ctx| {
            prekeys::install(ctx.conn, &bob_keys_clone)?;
            device_store::store_local(
                ctx.conn,
                bob_uid,
                &device_store::LocalDevice {
                    device_id: bob_dev1.to_owned(),
                    primary_device_id: bob_dev1.to_owned(),
                },
            )
        })
        .await
        .unwrap();

    // Test 1: Session using last-resort Kyber prekey rejects replayed base key
    let bundle_last_resort = PreKeyBundle::new(
        bob_keys.registration_id,
        libsignal_protocol::DeviceId::new(1).unwrap(),
        None,
        bob_keys.signed_pre_key_id.into(),
        bob_keys.signed_pre_key.public_key().unwrap(),
        bob_keys.signed_pre_key.signature().unwrap(),
        bob_keys.last_resort_id.into(),
        bob_keys.last_resort_kyber_pre_key.public_key().unwrap(),
        bob_keys.last_resort_kyber_pre_key.signature().unwrap(),
        *bob_keys.identity.identity_key(),
    )
    .unwrap();

    let first_ciphertext: Vec<u8> = alice_db
        .write_tx(move |ctx| {
            device_store::add(ctx.conn, bob_uid, bob_dev1)?;
            device_store::add(ctx.conn, bob_uid, bob_dev2)?;
            let remote = address_for(bob_dev1);
            let local = address_for(alice_dev);
            let mut s = ctx.signal_store();
            let mut i = ctx.signal_store();
            block_on(process_prekey_bundle(
                &remote,
                &local,
                &mut s,
                &mut i,
                &bundle_last_resort,
                SystemTime::now(),
                &mut rand::rng(),
            ))
            .unwrap();
            let ct = block_on(message_encrypt(
                b"hello bob",
                &remote,
                &local,
                &mut s,
                &mut i,
                SystemTime::now(),
                &mut rand::rng(),
            ))
            .unwrap();
            match ct {
                CiphertextMessage::PreKeySignalMessage(m) => Ok(m.serialized().to_vec()),
                _ => panic!("expected PreKeySignalMessage"),
            }
        })
        .await
        .unwrap();

    // Bob decrypts once -> succeeds, last-resort key stays in DB
    let ct_clone = first_ciphertext.clone();
    let pt = bob_db
        .write_tx(move |ctx| {
            device_store::add(ctx.conn, alice_uid, alice_dev)?;
            let pk_msg = PreKeySignalMessage::try_from(&ct_clone[..]).unwrap();
            let mut s = ctx.signal_store();
            let mut i = ctx.signal_store();
            let mut p = ctx.signal_store();
            let sp = ctx.signal_store();
            let mut kp = ctx.signal_store();
            Ok(block_on(message_decrypt(
                &CiphertextMessage::PreKeySignalMessage(pk_msg),
                &address_for(alice_dev),
                &address_for(bob_dev1),
                &mut s,
                &mut i,
                &mut p,
                &sp,
                &mut kp,
                &mut rand::rng(),
            ))
            .unwrap())
        })
        .await
        .unwrap();
    assert_eq!(pt, b"hello bob");

    // Replaying the same PreKeySignalMessage after deleting Bob's session is rejected because (kyber_id, signed_id, base_key) was recorded!
    let ct_replay = first_ciphertext.clone();
    let replay_failed = bob_db
        .write_tx(move |ctx| {
            ctx.conn.execute("DELETE FROM signal_sessions", []).unwrap();
            let pk_msg = PreKeySignalMessage::try_from(&ct_replay[..]).unwrap();
            let mut s = ctx.signal_store();
            let mut i = ctx.signal_store();
            let mut p = ctx.signal_store();
            let sp = ctx.signal_store();
            let mut kp = ctx.signal_store();
            let res = block_on(message_decrypt(
                &CiphertextMessage::PreKeySignalMessage(pk_msg),
                &address_for(alice_dev),
                &address_for(bob_dev1),
                &mut s,
                &mut i,
                &mut p,
                &sp,
                &mut kp,
                &mut rand::rng(),
            ));
            Ok(res.is_err())
        })
        .await
        .unwrap();
    assert!(
        replay_failed,
        "reused base key with last-resort Kyber prekey must fail"
    );

    // Test 2: Account-level identity change cascade on Alice when Bob resets his account
    let bob_new_identity = IdentityKeyPair::generate(&mut rand::rng());
    let bob_new_keys = prekeys::generate_provisioning_keys(bob_new_identity, 2_000)
        .await
        .unwrap();
    let bob_new_dev = "22222222-2222-4222-8222-2222222222d9";
    let new_bundle = PreKeyBundle::new(
        bob_new_keys.registration_id,
        libsignal_protocol::DeviceId::new(1).unwrap(),
        None,
        bob_new_keys.signed_pre_key_id.into(),
        bob_new_keys.signed_pre_key.public_key().unwrap(),
        bob_new_keys.signed_pre_key.signature().unwrap(),
        bob_new_keys.last_resort_id.into(),
        bob_new_keys.last_resort_kyber_pre_key.public_key().unwrap(),
        bob_new_keys.last_resort_kyber_pre_key.signature().unwrap(),
        *bob_new_keys.identity.identity_key(),
    )
    .unwrap();

    alice_db
        .write_tx(move |ctx| {
            device_store::add(ctx.conn, bob_uid, bob_new_dev)?;
            let mut s = ctx.signal_store();
            let mut i = ctx.signal_store();
            block_on(process_prekey_bundle(
                &address_for(bob_new_dev),
                &address_for(alice_dev),
                &mut s,
                &mut i,
                &new_bundle,
                SystemTime::now(),
                &mut rand::rng(),
            ))
            .unwrap();
            // Old devices and old sessions of Bob must have been wiped by save_identity!
            let remaining_devs = device_store::devices_of(ctx.conn, bob_uid)?;
            assert_eq!(remaining_devs, vec![bob_new_dev.to_owned()]);
            assert!(!SignalStore::contains_session(ctx.conn, bob_dev1)?);
            assert!(SignalStore::contains_session(ctx.conn, bob_new_dev)?);
            Ok(())
        })
        .await
        .unwrap();

    assert_eq!(
        *effects.lock().unwrap(),
        vec![PostCommitEffect::IdentityChanged(bob_uid.to_owned())]
    );

    alice_db.shutdown().await;
    bob_db.shutdown().await;
}

#[tokio::test]
async fn prekey_rotation_refill_and_archive_stale_cleanup() {
    let db = DbHandle::open(None, &[], None).unwrap();
    let identity = IdentityKeyPair::generate(&mut rand::rng());
    let t0 = 1_000_000i64;
    let keys = prekeys::generate_provisioning_keys(identity, t0)
        .await
        .unwrap();
    db.write_tx(move |ctx| prekeys::install(ctx.conn, &keys))
        .await
        .unwrap();

    assert!(!prekeys::is_sync_due(&db, t0 + 1_000).await.unwrap());
    assert!(
        prekeys::is_sync_due(&db, t0 + prekeys::REFRESH_INTERVAL_MS)
            .await
            .unwrap()
    );

    // 1st rotation & refill at t1 = t0 + 3 days
    let t1 = t0 + 3 * 24 * 60 * 60 * 1000;
    let refill1 = prekeys::prepare_refill(
        &db,
        prekeys::PreKeyCounts {
            one_time: 5,
            kyber: 5,
        },
        t1,
    )
    .await
    .unwrap();
    assert!(refill1.signed_pre_key.is_some());
    assert!(refill1.last_resort_kyber_pre_key.is_some());
    assert_eq!(refill1.one_time_pre_keys.len(), 100);
    assert_eq!(refill1.kyber_pre_keys.len(), 100);
    prekeys::confirm_refill(&db, &refill1, t1).await.unwrap();

    // 2nd rotation & refill at t2 = t1 + 3 days (now we have 300 one-time keys, 200 of them stale at t1/t2)
    let t2 = t1 + 3 * 24 * 60 * 60 * 1000;
    let refill2 = prekeys::prepare_refill(
        &db,
        prekeys::PreKeyCounts {
            one_time: 2,
            kyber: 2,
        },
        t2,
    )
    .await
    .unwrap();
    prekeys::confirm_refill(&db, &refill2, t2).await.unwrap();

    // 3rd rotation & cleanup at t3 = t2 + 95 days:
    // - Signed prekeys: active (from t3), youngest archived (from t2, kept!), older archived (from t0 and t1, deleted!)
    // - One-time prekeys: 100 fresh (from t3) + 200 stale (from t0/t1 older than 90 days) -> keeps MIN_ONE_TIME_KEPT (200) total!
    let t3 = t2 + STALE_ONE_TIME_AGE_MS + ARCHIVE_AGE_MS + 10_000;
    let refill3 = prekeys::prepare_refill(
        &db,
        prekeys::PreKeyCounts {
            one_time: 0,
            kyber: 0,
        },
        t3,
    )
    .await
    .unwrap();
    prekeys::confirm_refill(&db, &refill3, t3).await.unwrap();

    db.read(|conn| {
        let signed = SignalStore::load_all_signed_pre_keys(conn)?;
        let last_resort = SignalStore::load_last_resort_kyber_pre_keys(conn)?;
        // Active (t3) + 1 youngest archived (t2) = 2
        assert_eq!(signed.len(), 2);
        assert_eq!(last_resort.len(), 2);

        let ec_count: i64 =
            conn.query_row("SELECT count(*) FROM signal_prekeys", [], |r| r.get(0))?;
        let kyber_ot_count: i64 = conn.query_row(
            "SELECT count(*) FROM signal_kyber_prekeys WHERE last_resort = 0",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(ec_count, MIN_ONE_TIME_KEPT);
        assert_eq!(kyber_ot_count, MIN_ONE_TIME_KEPT);
        Ok(())
    })
    .await
    .unwrap();

    db.shutdown().await;
}

#[tokio::test]
async fn content_store_profile_merge_expiry_sweep_and_history_sync() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("content.db");
    let cache_dir = dir.path().join("cache");
    let key = [0x42u8; 32];

    let db = DbHandle::open(Some(db_path.to_str().unwrap()), &key, None).unwrap();

    // Cache an attachment file that should be purged when its pix expires
    let cached_file = attachment::write_cached(&cache_dir, "att_exp", b"jpegdata").unwrap();
    assert!(cached_file.exists());

    let peer = "22222222-2222-4222-8222-222222222222";
    let self_id = "11111111-1111-4111-8111-111111111111";

    db.write_tx(move |ctx| {
        // Profile merge tie-breaker: higher updated_at wins; on tie, higher author_device_id wins
        assert!(content_store::upsert_profile_if_newer(
            ctx.conn,
            &ProfileItem {
                user_id: peer.to_owned(),
                author_device_id: "dev_b".to_owned(),
                updated_at: 100,
                display_name: "Bob B".to_owned(),
                bio: "b".to_owned(),
                undelivered: false,
            },
        )?);
        assert!(!content_store::upsert_profile_if_newer(
            ctx.conn,
            &ProfileItem {
                user_id: peer.to_owned(),
                author_device_id: "dev_a".to_owned(),
                updated_at: 100,
                display_name: "Bob A".to_owned(),
                bio: "a".to_owned(),
                undelivered: false,
            },
        )?);
        assert!(content_store::upsert_profile_if_newer(
            ctx.conn,
            &ProfileItem {
                user_id: peer.to_owned(),
                author_device_id: "dev_c".to_owned(),
                updated_at: 100,
                display_name: "Bob C".to_owned(),
                bio: "c".to_owned(),
                undelivered: false,
            },
        )?);
        assert_eq!(
            content_store::get_profile(ctx.conn, peer)?
                .unwrap()
                .display_name,
            "Bob C"
        );

        let dm = ConversationItem::message(
            "dm1".to_owned(),
            peer.to_owned(),
            peer.to_owned(),
            1_000,
            "hello".to_owned(),
            None,
            false,
        );
        content_store::insert_conversation(ctx.conn, &dm)?;
        content_store::mark_conversation_viewed(
            ctx.conn,
            "dm1",
            2_000,
            expires_at(1_000, Some(2_000)),
        )?;

        let pix = ConversationItem::pix(
            "pix1".to_owned(),
            peer.to_owned(),
            self_id.to_owned(),
            1_000,
            MediaAttachment {
                id: "att_exp".to_owned(),
                content_key: vec![1u8; 32],
                nonce: vec![2u8; 12],
                media_type: MediaType::Photo,
            },
            Some("cap".to_owned()),
            None,
            5,
            Some(2_000),
            false,
        );
        content_store::insert_conversation(ctx.conn, &pix)?;

        let story = StoryItem::new(
            "st1".to_owned(),
            peer.to_owned(),
            1_000,
            "story text".to_owned(),
            None,
            None,
            false,
        );
        content_store::insert_story(ctx.conn, &story)?;
        Ok(())
    })
    .await
    .unwrap();

    // Export snapshot before expiry and import into a second database
    let snapshot = db
        .read(|conn| Ok(history_sync::export_snapshot(conn)?.unwrap()))
        .await
        .unwrap();
    let db2 = DbHandle::open(None, &[], None).unwrap();
    let snap_clone = snapshot.clone();
    db2.write_tx(move |ctx| {
        history_sync::import_snapshot(ctx.conn, &snap_clone)?;
        assert_eq!(content_store::get_messages(ctx.conn)?.len(), 2);
        assert_eq!(content_store::get_all_stories(ctx.conn)?.len(), 1);
        assert_eq!(content_store::get_profiles(ctx.conn)?.len(), 1);
        Ok(())
    })
    .await
    .unwrap();
    db2.shutdown().await;

    // Sweep expired at a future timestamp
    let sweep_time = 100_000_000_000i64;
    let outcome = db
        .write_tx(move |ctx| content_store::sweep_expired_in_tx(ctx.conn, sweep_time))
        .await
        .unwrap();
    assert_eq!(
        outcome.touched_models,
        vec![
            EntryModel::DirectMessage,
            EntryModel::Pix,
            EntryModel::Story,
        ]
    );
    assert_eq!(outcome.purged_media_refs, vec!["att_exp".to_owned()]);
    assert!(outcome.should_checkpoint);
    db.truncate_wal().await.unwrap();
    for mref in &outcome.purged_media_refs {
        attachment::purge_cached(&cache_dir, mref);
        let m = mref.clone();
        db.write_tx(move |ctx| content_store::remove_pending_media_purge(ctx.conn, &m))
            .await
            .unwrap();
    }
    assert!(!cached_file.exists());

    // Erased tombstones prevent re-inserting swept entries
    db.read(|conn| {
        assert!(!content_store::can_insert_conversation(conn, "dm1")?);
        assert!(!content_store::can_insert_story(conn, "st1")?);
        Ok(())
    })
    .await
    .unwrap();

    // FriendStore & DeviceStore conflict checks
    db.write_tx(|ctx| {
        friend_store::replace(
            ctx,
            &FriendList {
                version: 7,
                friends: vec![Friend {
                    user_id: peer.to_owned(),
                    username: "bob".to_owned(),
                    status: FriendStatus::Accepted,
                }],
            },
        )?;
        assert_eq!(friend_store::version(ctx.conn)?, 7);
        device_store::add(ctx.conn, peer, "shared_dev")?;
        assert!(matches!(
            device_store::add(ctx.conn, self_id, "shared_dev"),
            Err(ObscuraError::ProtocolViolation { .. })
        ));
        Ok(())
    })
    .await
    .unwrap();

    db.shutdown().await;
}
