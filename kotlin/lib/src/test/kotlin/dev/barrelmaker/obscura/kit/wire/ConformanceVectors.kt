package dev.barrelmaker.obscura.kit.wire

import org.json.JSONObject
import java.io.File

/** A vector file from `client-protocol/conformance/`, resolved from `:lib:test`'s working directory (`kotlin/lib`). */
fun loadVectors(name: String): JSONObject {
    val file = File("../../client-protocol/conformance/$name")
    check(file.exists()) { "conformance vector '$name' not found at ${file.path}" }
    return JSONObject(file.readText())
}

fun String.hex(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()

fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }
