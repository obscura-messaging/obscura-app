package dev.barrelmaker.obscura.kit.crypto

import java.util.Base64

internal fun ByteArray.toBase64(): String = Base64.getEncoder().encodeToString(this)
internal fun String.fromBase64(): ByteArray = Base64.getDecoder().decode(this)
internal fun String.fromBase64Url(): ByteArray = Base64.getUrlDecoder().decode(this)
