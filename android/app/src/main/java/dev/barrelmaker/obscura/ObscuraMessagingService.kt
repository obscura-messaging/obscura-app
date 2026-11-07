package dev.barrelmaker.obscura

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking

/**
 * Silent FCM push receiver. Server pushes `{ "action": "check" }` with no
 * content. This service just nudges [ObscuraSession] to drain queued
 * envelopes; the session's single message collector posts any notifications.
 *
 * The session is owned by the process (initialized in [MainApplication]),
 * which makes both warm and cold-start wakeups identical from our POV.
 */
class ObscuraMessagingService : FirebaseMessagingService() {

    companion object { private const val TAG = "ObscuraMessagingService" }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) {
        Log.d(TAG, "onNewToken: ${token.take(20)}...")
        ObscuraSession.deliverPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Log.d(TAG, "Silent push received, data=${message.data}")
        // OS gives us ~10 minutes; processPendingMessages internally caps at 25s.
        runBlocking { ObscuraSession.onPushWake() }
    }
}
