package dev.barrelmaker.obscura.kit

interface ObscuraLogger {
    fun log(message: String)
    fun decryptFailed(sourceUserId: String, reason: String)
    fun ackFailed(envelopeId: String, reason: String)
    fun tokenRefreshFailed(attempt: Int, reason: String)
    fun preKeyReplenishFailed(reason: String)
    fun identityChanged(userId: String)
    fun databaseError(store: String, operation: String, reason: String)
}

object NoOpLogger : ObscuraLogger {
    override fun log(message: String) {}
    override fun decryptFailed(sourceUserId: String, reason: String) {}
    override fun ackFailed(envelopeId: String, reason: String) {}
    override fun tokenRefreshFailed(attempt: Int, reason: String) {}
    override fun preKeyReplenishFailed(reason: String) {}
    override fun identityChanged(userId: String) {}
    override fun databaseError(store: String, operation: String, reason: String) {}
}
