package dev.barrelmaker.obscura.rustcore

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.util.Log
import java.io.File
import java.security.SecureRandom
import uniffi.obscura_core.CoreLogger
import uniffi.obscura_core.SpikeClient
import uniffi.obscura_core.setLogger

/**
 * Rust core spike: proves the packaged obscura-core loads on a device and completes one
 * session round trip. Only compiled when the build passes -PobscuraRustCore (see build.gradle).
 * Logs outcomes only, never keys or plaintext.
 */
object RustCoreSmoke {
    private const val TAG = "ObscuraRustCore"

    fun run(filesDir: File) {
        val dir = File(filesDir, "obscura-core-smoke")
        dir.deleteRecursively()
        dir.mkdirs()
        val random = SecureRandom()
        fun key() = ByteArray(32).also(random::nextBytes)

        val started = System.nanoTime()
        try {
            setLogger(object : CoreLogger {
                override fun log(message: String) {
                    Log.d(TAG, "core: $message")
                }
            })
            SpikeClient.open(File(dir, "alice.db").path, key(), "alice", 1u).use { alice ->
                SpikeClient.open(File(dir, "bob.db").path, key(), "bob", 1u).use { bob ->
                    alice.createIdentityAndBundle()
                    alice.processBundle("bob", 1u, bob.createIdentityAndBundle())
                    val sent = "smoke".toByteArray()
                    val received = bob.decrypt("alice", 1u, alice.encrypt("bob", 1u, sent))
                    val replySent = "smoke reply".toByteArray()
                    val reply = alice.decrypt("bob", 1u, bob.encrypt("alice", 1u, replySent))
                    val ok = received.contentEquals(sent) && reply.contentEquals(replySent)
                    val ms = (System.nanoTime() - started) / 1_000_000
                    Log.i(TAG, "round trip ${if (ok) "ok" else "MISMATCH"} in $ms ms")
                }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "round trip failed", e)
        } finally {
            dir.deleteRecursively()
        }
    }
}

/** Starts [RustCoreSmoke] off the main thread at process start. */
class RustCoreSmokeProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val filesDir = context?.filesDir ?: return false
        Thread({ RustCoreSmoke.run(filesDir) }, "obscura-core-smoke").start()
        return true
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0
}
