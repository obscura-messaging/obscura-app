#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Registers the Swift `ObscuraBridge` (an RCTEventEmitter) with React Native.
// addListener/removeListeners are inherited from RCTEventEmitter and exposed
// automatically. Every Swift @objc RPC must also be declared here.
@interface RCT_EXTERN_MODULE(ObscuraBridge, RCTEventEmitter)

// ── Auth + state reads ────────────────────────────────────────────────────
RCT_EXTERN_METHOD(registerUser:(NSString *)username password:(NSString *)password
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(login:(NSString *)username password:(NSString *)password
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(loginAndProvision:(NSString *)username password:(NSString *)password
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(connect:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(logout:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(wipeDevice:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getConnectionState:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getAuthState:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getUserId:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getUsername:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getDeviceId:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Friends + device linking ──────────────────────────────────────────────
RCT_EXTERN_METHOD(acceptFriend:(NSString *)userId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(removeFriend:(NSString *)userId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getFriendCode:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(addFriendByCode:(NSString *)code
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getFriends:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(generateLinkCode:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(validateAndApproveLink:(NSString *)code
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Typing signals ────────────────────────────────────────────────────────
RCT_EXTERN_METHOD(sendTyping:(NSArray *)recipientUserIds conversationId:(NSString *)conversationId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopTyping:(NSArray *)recipientUserIds conversationId:(NSString *)conversationId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(observeTyping:(NSString *)conversationId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopObservingTyping:(NSString *)conversationId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Attachments ───────────────────────────────────────────────────────────
RCT_EXTERN_METHOD(uploadAttachment:(NSString *)filePath
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(downloadAttachment:(NSString *)id contentKey:(NSString *)contentKey nonce:(NSString *)nonce
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(purgeAttachment:(NSString *)id
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Image processing ──────────────────────────────────────────────────────
RCT_EXTERN_METHOD(resizeImage:(NSString *)srcPath maxDim:(NSInteger)maxDim quality:(NSInteger)quality
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(writeTestImage:(NSInteger)width height:(NSInteger)height
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Misc ──────────────────────────────────────────────────────────────────
RCT_EXTERN_METHOD(setClipboard:(NSString *)text
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(deleteFile:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(prewarmAudioSession:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Deep linking + debug log ──────────────────────────────────────────────
RCT_EXTERN_METHOD(getLaunchIntent:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getDebugLog:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Push permission + kit token registration ─────────────────────────────
RCT_EXTERN_METHOD(requestPushPermission:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(registerPushToken:(NSString *)token
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Kit data surface ─────────────────────────────────────────────────────
//
// These MUST mirror the @objc selectors in ObscuraBridge.swift. A Swift @objc method with no
// RCT_EXTERN_METHOD here compiles but is invisible to React Native.
RCT_EXTERN_METHOD(inboxPeek:(nonnull NSNumber *)limit
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(inboxConsume:(NSArray *)ids
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(inboxDiscard:(NSArray *)ids reason:(NSString *)reason
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(inboxDepth:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(entryPut:(NSString *)model id:(NSString *)id dataJson:(NSString *)dataJson
                  sentAt:(nonnull NSNumber *)sentAt authorDeviceId:(NSString *)authorDeviceId
                  localMetadataJson:(NSString * _Nullable)localMetadataJson
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(entryAll:(NSString *)model
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(entryGet:(NSString *)model ids:(NSArray *)ids
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(entryErase:(NSString *)model ids:(NSArray *)ids
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendEntry:(NSArray *)recipientUserIds modelKey:(NSString *)modelKey
                  entryId:(NSString *)entryId sentAt:(nonnull NSNumber *)sentAt
                  payloadJson:(NSString *)payloadJson
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

@end
